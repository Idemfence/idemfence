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
 * - `COMMIT_REJECTED`: the server answered `COMMIT` with an error, so the transaction was
 *   rolled back for certain. The `cause` is the server's error (SQLSTATE in `cause.code`).
 * - `COMMIT_UNKNOWN`: the connection failed during `COMMIT` with no answer from the server,
 *   so the transaction may or may not have committed. The `cause` is the driver's error.
 */
export type IdemfenceStoreErrorCode =
  | "SCHEMA_VERSION_MISMATCH"
  | "SCHEMA_NAME_INVALID"
  | "BEGIN_RACE_EXHAUSTED"
  | "TRANSACTION_UNAVAILABLE"
  | "COMMIT_REJECTED"
  | "COMMIT_UNKNOWN";

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
  /** The key is in flight under a valid lease with the same fingerprint (row 8). */
  | { readonly outcome: "in_flight"; readonly retryAfterMs: number };

/** The part of a query result idemfence reads. */
export interface SqlResult<R> {
  readonly rows: R[];
  /** Rows affected by a statement, or null when the driver does not report it. */
  readonly rowCount: number | null;
}

/**
 * Runs parameterised SQL (`$1`, `$2`, ... placeholders) on one connection, pool or
 * transaction. A `pg` `Pool` and `PoolClient` satisfy it as they are; another driver plugs
 * in by implementing `query`. In transactional mode the handler receives the transaction's
 * executor as `ctx.tx`, and a store that supports the mode accepts an executor on each
 * operation so the record is written inside the caller's transaction.
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
 * A store that can also run the handler inside one of its transactions (transactional mode,
 * docs/contract.md section 7). `transaction` commits when `fn` resolves, rolls back when it
 * rejects (rethrowing `fn`'s rejection unchanged), and holds one connection for the whole
 * call. Its own failures are `IdemfenceStoreError`s: `TRANSACTION_UNAVAILABLE`,
 * `COMMIT_REJECTED` or `COMMIT_UNKNOWN`.
 */
export interface TransactionalStore extends Store {
  /** The `lock_timeout` applied to each transaction, in milliseconds. */
  readonly lockTimeoutMs: number;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /**
   * Every operation also takes an optional executor; given one, it runs on it (inside the
   * caller's transaction) instead of on the store's own connections. Inside `transaction`,
   * operations MUST be given its executor: taking a second connection while holding one
   * would deadlock a saturated pool.
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
