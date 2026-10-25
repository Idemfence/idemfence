import type { Pool, PoolClient } from "pg";
import { type Duration, lockTimeoutMs } from "../../config.js";
import { IdemfenceStoreError, type SqlExecutor } from "../../store.js";

export interface TransactionOptions {
  /**
   * `SET LOCAL lock_timeout` for the transaction; default `"250ms"`. A statement that waits
   * longer than this for a row lock fails, which is how a concurrent request on the same
   * key is turned into a 409 (docs/contract.md section 7). Invalid values throw
   * `IdemfenceConfigError` with code `LOCK_TIMEOUT_INVALID`.
   */
  lockTimeout?: Duration;
}

/**
 * Runs `fn` inside one transaction on a client taken from `pool`: `BEGIN`, `SET LOCAL
 * lock_timeout`, `fn(tx)`, then `COMMIT` when `fn` resolves or `ROLLBACK` when it rejects,
 * in which case the rejection is rethrown unchanged. The client is always returned to the
 * pool, and destroyed instead when the connection errored or `ROLLBACK` itself failed, so a
 * connection whose state is unknown never serves another caller.
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
  try {
    let result: T;
    try {
      await client.query("BEGIN");
      // lock_timeout is a server setting, not a bind parameter; the value is a validated
      // integer.
      await client.query(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);
    } catch (error) {
      // ROLLBACK here is for the client's sake: on a dead connection it fails and marks
      // the client broken, so it is destroyed instead of going back to the pool.
      await rollback();
      throw unavailable(error);
    }
    try {
      result = await fn(executor(client));
    } catch (error) {
      await rollback();
      throw error;
    }
    let committed: { command?: string };
    try {
      committed = await client.query("COMMIT");
    } catch (error) {
      await rollback();
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
    // An aborted transaction (a failed statement that fn swallowed) answers COMMIT with a
    // ROLLBACK tag and no error: nothing was committed.
    if (committed.command !== "COMMIT") {
      throw new IdemfenceStoreError(
        "COMMIT_REJECTED",
        `COMMIT answered ${committed.command ?? "nothing"}: the transaction was already aborted and has been rolled back.`,
      );
    }
    return result;
  } finally {
    client.removeListener("error", onError);
    // release(true) destroys the client rather than returning it to the pool.
    client.release(broken);
  }

  async function rollback(): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
  }
}

function unavailable(error: unknown): IdemfenceStoreError {
  return new IdemfenceStoreError(
    "TRANSACTION_UNAVAILABLE",
    "A transaction could not be opened; nothing ran.",
    { cause: error },
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

/** Exposes only `query`, so the handler cannot release the pooled client. */
function executor(client: PoolClient): SqlExecutor {
  return {
    query: (text, params) => client.query(text, params ? [...params] : []),
  };
}
