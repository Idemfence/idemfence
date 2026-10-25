import type { Pool, PoolClient } from "pg";
import { type Duration, lockTimeoutMs } from "../../config.js";
import {
  IdemfenceStoreError,
  type SqlExecutor,
  type StoreTransaction,
} from "../../store.js";

export interface TransactionOptions {
  /**
   * `SET LOCAL lock_timeout` for the whole transaction; default `"250ms"`. A statement that
   * waits longer than this for a lock fails. The store's `begin` scopes its own wait to the
   * store's `lockTimeout` whatever this is, and restores this value before returning.
   * Invalid values throw `IdemfenceConfigError` with code `LOCK_TIMEOUT_INVALID`.
   */
  lockTimeout?: Duration;
}

/**
 * Runs `fn` inside one transaction on a client taken from `pool`: `BEGIN`, `SET LOCAL
 * lock_timeout`, `fn(tx)`, then `COMMIT` when `fn` resolves or `ROLLBACK` when it rejects,
 * in which case the rejection is rethrown unchanged. The client is always returned to the
 * pool, and destroyed instead when the connection errored or `ROLLBACK` itself failed, so a
 * connection whose state is unknown never serves another caller. Once the transaction has
 * ended, a query on `tx` rejects with `TRANSACTION_ENDED` without reaching the client.
 *
 * Failures of the transaction itself reject with `IdemfenceStoreError` (the driver's error
 * as `cause`): `TRANSACTION_UNAVAILABLE` when no client could be taken or `BEGIN` or
 * `SET LOCAL` failed (nothing ran); `COMMIT_REJECTED` when the server answered `COMMIT`
 * with an error or with a `ROLLBACK` tag because the transaction was already aborted
 * (rolled back for certain); `COMMIT_UNKNOWN` when the connection failed
 * during `COMMIT` with no answer from the server (the transaction may have committed).
 *
 * The transaction holds the connection for the whole call: size the pool for the number of
 * handlers that may run at once, and set `idle_in_transaction_session_timeout` on the server
 * so a stalled handler cannot pin a connection forever.
 */
export async function withTransaction<T>(
  pool: Pool,
  options: TransactionOptions,
  fn: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  // Validated before a client is taken, so a bad option never costs a connection.
  const lockTimeout = lockTimeoutMs(options.lockTimeout);
  const transaction = await openTransaction(pool, lockTimeout);
  let result: T;
  try {
    result = await fn(transaction.executor);
  } catch (error) {
    // A failed ROLLBACK has already destroyed the client; fn's rejection is what the caller
    // needs to see.
    await transaction.rollback().catch(() => undefined);
    throw error;
  }
  await transaction.commit();
  return result;
}

/**
 * `BEGIN` (and, with `lockTimeout`, `SET LOCAL lock_timeout`) on a client taken from
 * `pool`, returned as a {@link StoreTransaction}. `commit` and `rollback` each end the
 * transaction and release the client exactly once; the client is destroyed instead of
 * returned when the connection errored or `ROLLBACK` failed.
 */
export async function openTransaction(
  pool: Pool,
  lockTimeout?: number,
): Promise<StoreTransaction> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw unavailable(error);
  }
  // A checked-out pg client has no error listener; without one, a backend that dies
  // mid-transaction would raise an unhandled 'error' event instead of failing the query.
  let broken = false;
  const onError = () => {
    broken = true;
  };
  client.on("error", onError);
  let ended = false;

  const release = () => {
    client.removeListener("error", onError);
    // release(true) destroys the client rather than returning it to the pool.
    client.release(broken);
  };
  // ROLLBACK that never rejects; a failure marks the client broken so it is destroyed.
  const rollbackQuietly = async (): Promise<unknown> => {
    try {
      await client.query("ROLLBACK");
      return undefined;
    } catch (error) {
      broken = true;
      return error;
    }
  };

  try {
    await client.query("BEGIN");
    if (lockTimeout !== undefined) {
      // lock_timeout is a server setting, not a bind parameter; the value is a validated
      // integer.
      await client.query(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);
    }
  } catch (error) {
    // ROLLBACK here is for the client's sake: on a dead connection it fails and marks the
    // client broken, so it is destroyed instead of going back to the pool.
    ended = true;
    await rollbackQuietly();
    release();
    throw unavailable(error);
  }

  return {
    // Exposes only `query`, so the handler cannot release the pooled client. Once the
    // transaction has ended the client may already serve another caller, so a late query
    // is refused here rather than sent.
    executor: {
      query: (text, params) =>
        ended
          ? Promise.reject(transactionEnded())
          : client.query(text, params ? [...params] : []),
    },

    async commit() {
      if (ended) {
        throw transactionEnded();
      }
      ended = true;
      let committed: { command?: string };
      try {
        committed = await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly();
        release();
        // Only an ordinary ERROR answered by a server that is still talking to us proves the
        // transaction was aborted. A FATAL or PANIC, a connection-class SQLSTATE, or a client
        // that the follow-up ROLLBACK found broken may hide a commit that already landed.
        throw isDefiniteRejection(error) && !broken
          ? new IdemfenceStoreError(
              "COMMIT_REJECTED",
              "The server rejected COMMIT; the transaction was rolled back.",
              { cause: error },
            )
          : new IdemfenceStoreError(
              "COMMIT_UNKNOWN",
              "The connection failed during COMMIT; the transaction may or may not have committed.",
              { cause: error },
            );
      }
      release();
      // An aborted transaction (a failed statement that was swallowed) answers COMMIT with a
      // ROLLBACK tag and no error: nothing was committed.
      if (committed.command !== "COMMIT") {
        throw new IdemfenceStoreError(
          "COMMIT_REJECTED",
          `COMMIT answered ${committed.command ?? "nothing"}: the transaction was already aborted and has been rolled back.`,
        );
      }
    },

    async rollback() {
      if (ended) {
        return;
      }
      ended = true;
      const failure = await rollbackQuietly();
      release();
      if (failure !== undefined) {
        throw failure;
      }
    },
  };
}

function unavailable(error: unknown): IdemfenceStoreError {
  return new IdemfenceStoreError(
    "TRANSACTION_UNAVAILABLE",
    "A transaction could not be opened; nothing ran.",
    { cause: error },
  );
}

function transactionEnded(): IdemfenceStoreError {
  return new IdemfenceStoreError(
    "TRANSACTION_ENDED",
    "This transaction has already committed or rolled back; its executor (ctx.tx) cannot be used any more.",
  );
}

// SQLSTATE classes that describe the connection or the server rather than the statement:
// 08 connection exception, 57 operator intervention (57P01 admin shutdown and so on),
// XX internal error.
const AMBIGUOUS_SQLSTATE_CLASSES = new Set(["08", "57", "XX"]);

/**
 * True for an error the server returned for the statement itself: pg gives those a
 * severity and a five-character SQLSTATE. Severity ERROR only; FATAL and PANIC end the
 * session, and the connection and internal classes say nothing about the transaction.
 */
function isDefiniteRejection(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { severity, code } = error as { severity?: unknown; code?: unknown };
  return (
    severity === "ERROR" &&
    typeof code === "string" &&
    /^[0-9A-Z]{5}$/.test(code) &&
    !AMBIGUOUS_SQLSTATE_CLASSES.has(code.slice(0, 2))
  );
}
