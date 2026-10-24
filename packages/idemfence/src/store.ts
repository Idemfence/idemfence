/**
 * Stable codes for {@link IdemfenceStoreError}:
 *
 * - `SCHEMA_VERSION_MISMATCH`: the store's schema is missing or not the version this package
 *   expects; run the shipped migrations.
 * - `SCHEMA_NAME_INVALID`: the `schema` option is not a valid, unquoted Postgres identifier.
 * - `BEGIN_RACE_EXHAUSTED`: the record kept disappearing between the statements of `begin`
 *   after the maximum number of attempts.
 */
export type IdemfenceStoreErrorCode =
  | "SCHEMA_VERSION_MISMATCH"
  | "SCHEMA_NAME_INVALID"
  | "BEGIN_RACE_EXHAUSTED";

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
