/**
 * Stable codes for {@link IdemfenceStoreError}:
 *
 * - `SCHEMA_VERSION_MISMATCH`: the store's schema is missing or not the version this package
 *   expects; run the shipped migrations.
 * - `SCHEMA_NAME_INVALID`: the `schema` option is not a valid, unquoted Postgres identifier.
 * - `BEGIN_RACE_EXHAUSTED`: the record kept disappearing between the statements of `begin`
 *   after the maximum number of attempts.
 * - `TRANSACTION_UNAVAILABLE`: a transaction could not be opened (no connection, or `BEGIN`
 *   or `SET LOCAL` failed); nothing ran. The `cause` is the driver's error.
 * - `COMMIT_REJECTED`: the server answered `COMMIT` with an error, or with a `ROLLBACK` tag
 *   because the transaction was already aborted, so it was rolled back for certain. For an
 *   error, the `cause` is the server's error (SQLSTATE in `cause.code`).
 * - `COMMIT_UNKNOWN`: the connection failed during `COMMIT` with no answer from the server,
 *   so the transaction may or may not have committed. The `cause` is the driver's error.
 * - `TRANSACTION_ENDED`: a query was sent on a transaction's executor (such as `ctx.tx`)
 *   after that transaction committed or rolled back. The query never reached the
 *   connection, which may already serve another caller.
 */
export type IdemfenceStoreErrorCode =
  | "SCHEMA_VERSION_MISMATCH"
  | "SCHEMA_NAME_INVALID"
  | "BEGIN_RACE_EXHAUSTED"
  | "TRANSACTION_UNAVAILABLE"
  | "COMMIT_REJECTED"
  | "COMMIT_UNKNOWN"
  | "TRANSACTION_ENDED";

/** Thrown by a store for conditions that are not a normal `begin` outcome. */
export class IdemfenceStoreError extends Error {
  readonly code: IdemfenceStoreErrorCode;

  constructor(
    code: IdemfenceStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IdemfenceStoreError";
    this.code = code;
  }
}

/** A completed record's response as stored (docs/contract.md section 5). */
export interface StoredResponse {
  readonly status: number;
  /** Header name/value pairs, in order; names are lowercase. */
  readonly headers: readonly (readonly [string, string])[];
  /** The response body, or null when it was omitted because it exceeded the body cap. */
  readonly body: Uint8Array | null;
  readonly bodyOmitted: boolean;
}

/** The outcome of {@link Store.begin}, mapped to contract rows 5 to 10 by the engine. */
export type BeginResult =
  /** A lease was acquired (row 5, 9 or 10); the handler may run. */
  | {
      readonly outcome: "acquired";
      readonly fencingToken: bigint;
      readonly attempts: number;
    }
  /** The key is completed with the same fingerprint (row 6). */
  | { readonly outcome: "replay"; readonly response: StoredResponse }
  /** The key exists with a different fingerprint, completed or in flight (row 7). */
  | { readonly outcome: "mismatch" }
  /**
   * The key is in flight with the same fingerprint (row 8): under a valid lease, with
   * `retryAfterMs` the remaining lease, or, for a `begin` given an executor, held by another
   * uncommitted transaction past the lock timeout, with `retryAfterMs` the lock timeout.
   */
  | { readonly outcome: "in_flight"; readonly retryAfterMs: number };

/** The part of a query result idemfence reads. */
export interface SqlResult<R> {
  readonly rows: R[];
  /** Rows affected by a statement, or null when the driver does not report it. */
  readonly rowCount: number | null;
  /** The server's command tag (`COMMIT`, `ROLLBACK`, `UPDATE`, ...) when the driver reports it. */
  readonly command?: string;
}

/**
 * Runs parameterised SQL (`$1`, `$2`, ... placeholders) on one connection, pool or
 * transaction. A `pg` `Pool` and `PoolClient` satisfy it as they are; another driver plugs
 * in by implementing `query`. In transactional mode the handler receives the transaction's
 * executor as `ctx.tx`, and a store that supports the mode accepts an executor on each
 * operation so the record is written inside that same transaction.
 */
export interface SqlExecutor {
  query<R extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<R>>;
}

/**
 * Lease-mode storage (docs/contract.md section 7). All time comparisons use the store's own
 * clock. Every write after `begin` is conditional on the fencing token and reports `"fenced"`
 * when another attempt has taken the lease over.
 */
export interface Store {
  /** Verifies the schema; rejects with `SCHEMA_VERSION_MISMATCH` otherwise. */
  ready(): Promise<void>;
  begin(
    lookupKey: Uint8Array,
    fingerprint: Uint8Array,
    leaseMs: number,
    retentionMs: number,
  ): Promise<BeginResult>;
  renew(
    lookupKey: Uint8Array,
    fencingToken: bigint,
    leaseMs: number,
  ): Promise<"renewed" | "fenced">;
  complete(
    lookupKey: Uint8Array,
    fencingToken: bigint,
    response: StoredResponse,
  ): Promise<"completed" | "fenced">;
  release(
    lookupKey: Uint8Array,
    fencingToken: bigint,
  ): Promise<"released" | "fenced">;
  /** Deletes up to `limit` records past retention, never a live lease; returns the count. */
  purgeExpired(limit: number): Promise<number>;
}

/**
 * One open transaction on one connection, from {@link TransactionalStore.openTransaction}.
 * Exactly one of `commit` or `rollback` ends it and gives the connection back; after that,
 * every query on `executor` rejects with `TRANSACTION_ENDED` without reaching the connection.
 */
export interface StoreTransaction {
  /** Runs queries inside the transaction (the handler's `ctx.tx` in transactional mode). */
  readonly executor: SqlExecutor;
  /**
   * `COMMIT`. Rejects with `COMMIT_REJECTED` (rolled back for certain, including a
   * transaction that a failed statement had already aborted) or `COMMIT_UNKNOWN` (the
   * connection failed during `COMMIT`; it may have committed).
   */
  commit(): Promise<void>;
  /**
   * `ROLLBACK`. Rejects with the driver's error when `ROLLBACK` itself failed; the connection
   * is then destroyed instead of returned, and nothing was committed either way.
   */
  rollback(): Promise<void>;
}

/**
 * A store that can also write the record inside the handler's own transaction
 * (transactional mode, docs/contract.md section 7).
 */
export interface TransactionalStore extends Store {
  /**
   * How long `begin` given an executor waits for another transaction that holds the same
   * key, in milliseconds.
   */
  readonly lockTimeoutMs: number;
  /**
   * `BEGIN` on one connection of the store's own, held until the transaction ends. Rejects
   * with `TRANSACTION_UNAVAILABLE` when no connection could be taken or `BEGIN` failed.
   */
  openTransaction(): Promise<StoreTransaction>;
  /**
   * Every operation also takes an optional executor; given one, it runs on it (inside the
   * caller's transaction) instead of on the store's own connections. While a transaction is
   * open, an operation MUST be given its executor: taking a second connection while holding
   * one would deadlock a saturated pool. `renew` has no place inside a transaction: the
   * update would be invisible to other sessions until commit and would row-lock the record.
   *
   * Given an executor, `begin` waits at most `lockTimeoutMs` for another transaction that
   * holds the same key and then resolves `in_flight` with `retryAfterMs` set to
   * `lockTimeoutMs`. A serialization failure (SQLSTATE 40001, under REPEATABLE READ or
   * SERIALIZABLE when the holder commits during the wait) resolves the same way, since a
   * retry sees the committed record. After either, the caller's transaction is aborted and
   * must be rolled back. Otherwise `begin` restores the `lock_timeout` that was in effect
   * before it ran, so the caller's later statements run with their normal setting.
   */
  begin(
    lookupKey: Uint8Array,
    fingerprint: Uint8Array,
    leaseMs: number,
    retentionMs: number,
    executor?: SqlExecutor,
  ): Promise<BeginResult>;
  renew(
    lookupKey: Uint8Array,
    fencingToken: bigint,
    leaseMs: number,
    executor?: SqlExecutor,
  ): Promise<"renewed" | "fenced">;
  complete(
    lookupKey: Uint8Array,
    fencingToken: bigint,
    response: StoredResponse,
    executor?: SqlExecutor,
  ): Promise<"completed" | "fenced">;
  release(
    lookupKey: Uint8Array,
    fencingToken: bigint,
    executor?: SqlExecutor,
  ): Promise<"released" | "fenced">;
  purgeExpired(limit: number, executor?: SqlExecutor): Promise<number>;
}
