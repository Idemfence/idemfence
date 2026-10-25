import type { Pool, PoolClient } from "pg";
import { type Duration, lockTimeoutMs } from "../../config.js";
import type { SqlExecutor } from "../../store.js";

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
  const client = await pool.connect();
  // A checked-out pg client has no error listener; without one, a backend that dies
  // mid-transaction would raise an unhandled 'error' event instead of failing the query.
  let broken = false;
  const onError = () => {
    broken = true;
  };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    // lock_timeout is a server setting, not a bind parameter; the value is a validated integer.
    await client.query(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);
    const result = await fn(executor(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.removeListener("error", onError);
    // release(true) destroys the client rather than returning it to the pool.
    client.release(broken);
  }
}

/** Exposes only `query`, so the handler cannot release the pooled client. */
function executor(client: PoolClient): SqlExecutor {
  return {
    query: (text, params) => client.query(text, params ? [...params] : []),
  };
}
