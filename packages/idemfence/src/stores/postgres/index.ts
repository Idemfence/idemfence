import type { Pool } from "pg";
import { type Duration, lockTimeoutMs } from "../../config.js";
import {
  type BeginResult,
  IdemfenceStoreError,
  type SqlExecutor,
  type StoredResponse,
  type TransactionalStore,
} from "../../store.js";
import { withTransaction } from "./transaction.js";

export {
  type BeginResult,
  IdemfenceStoreError,
  type IdemfenceStoreErrorCode,
  type SqlExecutor,
  type SqlResult,
  type Store,
  type StoredResponse,
  type TransactionalStore,
} from "../../store.js";
export { type TransactionOptions, withTransaction } from "./transaction.js";

export interface PostgresStoreOptions {
  /** The caller's pool. The store never creates connections or reads environment variables. */
  pool: Pool;
  /** Schema holding the idemfence tables; default `public`. */
  schema?: string;
  /**
   * `lock_timeout` for the transactions this store opens (transactional mode); default
   * `"250ms"`. Invalid values throw `IdemfenceConfigError` with code `LOCK_TIMEOUT_INVALID`.
   */
  lockTimeout?: Duration;
}

/** The Postgres store: a {@link TransactionalStore} on the caller's pool. */
export type PostgresStore = TransactionalStore;

const SCHEMA_VERSION = 1;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const BEGIN_ATTEMPTS = 3;
const UNDEFINED_TABLE = "42P01";

interface RecordRow {
  state: "in_flight" | "completed";
  fingerprint: Buffer;
  response_status: number | null;
  response_headers: [string, string][] | null;
  response_body: Buffer | null;
  body_omitted: boolean;
  lease_remaining_ms: number;
  retention_expired: boolean;
}

/** A {@link PostgresStore} on the caller's pool; see migrations/001_init.sql for the schema. */
export function postgresStore(options: PostgresStoreOptions): PostgresStore {
  const schema = options.schema ?? "public";
  if (!SCHEMA_NAME.test(schema)) {
    throw new IdemfenceStoreError(
      "SCHEMA_NAME_INVALID",
      "Option `schema` must match /^[a-z_][a-z0-9_]{0,62}$/.",
    );
  }
  return new PgStore(options.pool, schema, lockTimeoutMs(options.lockTimeout));
}

class PgStore implements PostgresStore {
  private readonly sql: Sql;

  constructor(
    private readonly pool: Pool,
    schema: string,
    readonly lockTimeoutMs: number,
  ) {
    this.sql = statements(
      `"${schema}".idemfence_meta`,
      `"${schema}".idemfence_records`,
      `"${schema}".idemfence_fencing_token_seq`,
    );
  }

  async ready(): Promise<void> {
    let version: unknown;
    try {
      const result = await this.pool.query<{ version: number }>(
        this.sql.version,
      );
      version = result.rows[0]?.version;
    } catch (error) {
      if (isPgError(error) && error.code === UNDEFINED_TABLE) {
        throw new IdemfenceStoreError(
          "SCHEMA_VERSION_MISMATCH",
          `The idemfence tables are missing; apply migrations/001_init.sql (schema version ${SCHEMA_VERSION}).`,
          { cause: error },
        );
      }
      throw error;
    }
    if (version !== SCHEMA_VERSION) {
      throw new IdemfenceStoreError(
        "SCHEMA_VERSION_MISMATCH",
        `The idemfence schema is version ${String(version)}; this package requires version ${SCHEMA_VERSION}.`,
      );
    }
  }

  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, { lockTimeout: this.lockTimeoutMs }, fn);
  }

  async begin(
    lookupKey: Uint8Array,
    fingerprint: Uint8Array,
    leaseMs: number,
    retentionMs: number,
    executor: SqlExecutor = this.pool,
  ): Promise<BeginResult> {
    const key = bytes(lookupKey);
    for (let attempt = 1; attempt <= BEGIN_ATTEMPTS; attempt += 1) {
      const acquired = await executor.query<{
        fencing_token: string;
        attempts: number;
      }>(this.sql.begin, [key, bytes(fingerprint), leaseMs, retentionMs]);
      const row = acquired.rows[0];
      if (row !== undefined) {
        return {
          outcome: "acquired",
          fencingToken: BigInt(row.fencing_token),
          attempts: row.attempts,
        };
      }

      // The row exists and could not be taken over: classify it. It may have vanished or
      // expired between the two statements; then the insert is simply tried again.
      const existing = (
        await executor.query<RecordRow>(this.sql.classify, [key])
      ).rows[0];
      if (existing === undefined || existing.retention_expired) {
        continue;
      }
      const sameFingerprint = existing.fingerprint.equals(fingerprint);
      if (existing.state === "completed") {
        return sameFingerprint
          ? { outcome: "replay", response: storedResponse(existing) }
          : { outcome: "mismatch" };
      }
      // A different fingerprint is a reuse (row 7) whether the lease is live or expired: a
      // 409 would invite a retry that can never succeed, and a takeover would let a different
      // payload claim a key whose first attempt may already have had side effects.
      if (!sameFingerprint) {
        return { outcome: "mismatch" };
      }
      if (existing.lease_remaining_ms <= 0) {
        continue;
      }
      return {
        outcome: "in_flight",
        retryAfterMs: Math.ceil(existing.lease_remaining_ms),
      };
    }
    throw new IdemfenceStoreError(
      "BEGIN_RACE_EXHAUSTED",
      `The record changed between statements on each of ${BEGIN_ATTEMPTS} begin attempts.`,
    );
  }

  async renew(
    lookupKey: Uint8Array,
    fencingToken: bigint,
    leaseMs: number,
    executor: SqlExecutor = this.pool,
  ): Promise<"renewed" | "fenced"> {
    const result = await executor.query(this.sql.renew, [
      bytes(lookupKey),
      fencingToken.toString(),
      leaseMs,
    ]);
    return result.rowCount === 1 ? "renewed" : "fenced";
  }

  async complete(
    lookupKey: Uint8Array,
    fencingToken: bigint,
    response: StoredResponse,
    executor: SqlExecutor = this.pool,
  ): Promise<"completed" | "fenced"> {
    const result = await executor.query(this.sql.complete, [
      bytes(lookupKey),
      fencingToken.toString(),
      response.status,
      JSON.stringify(response.headers),
      response.body === null ? null : bytes(response.body),
      response.bodyOmitted,
    ]);
    return result.rowCount === 1 ? "completed" : "fenced";
  }

  async release(
    lookupKey: Uint8Array,
    fencingToken: bigint,
    executor: SqlExecutor = this.pool,
  ): Promise<"released" | "fenced"> {
    const result = await executor.query(this.sql.release, [
      bytes(lookupKey),
      fencingToken.toString(),
    ]);
    return result.rowCount === 1 ? "released" : "fenced";
  }

  async purgeExpired(
    limit: number,
    executor: SqlExecutor = this.pool,
  ): Promise<number> {
    const result = await executor.query(this.sql.purge, [limit]);
    return result.rowCount ?? 0;
  }
}

type Sql = ReturnType<typeof statements>;

// Every time comparison uses clock_timestamp(): the store's clock, never the application's.
function statements(meta: string, records: string, sequence: string) {
  return {
    version: `SELECT version FROM ${meta}`,

    // A takeover (expired lease with the same fingerprint, or retention expired with no live
    // lease) draws a new fencing token so the
    // previous holder's later complete/renew/release no longer match. Tokens come from a
    // sequence, so they only grow and are never reused. Retention expiry makes the row a
    // fresh record (attempts and created_at reset); a lease takeover is one more attempt.
    // EXCLUDED.fencing_token is the value VALUES already drew, so one attempt draws one token.
    begin: `
      INSERT INTO ${records} AS r
        (lookup_key, fingerprint, state, fencing_token, lease_expires_at, created_at, expires_at)
      VALUES
        ($1, $2, 'in_flight', nextval('${sequence}'),
         clock_timestamp() + $3::bigint * interval '1 millisecond',
         clock_timestamp(),
         clock_timestamp() + $4::bigint * interval '1 millisecond')
      ON CONFLICT (lookup_key) DO UPDATE SET
        fingerprint = EXCLUDED.fingerprint,
        state = 'in_flight',
        fencing_token = EXCLUDED.fencing_token,
        lease_expires_at = EXCLUDED.lease_expires_at,
        expires_at = EXCLUDED.expires_at,
        attempts = CASE WHEN r.expires_at <= clock_timestamp() THEN 1 ELSE r.attempts + 1 END,
        created_at = CASE WHEN r.expires_at <= clock_timestamp() THEN EXCLUDED.created_at ELSE r.created_at END,
        response_status = NULL,
        response_headers = NULL,
        response_body = NULL,
        body_omitted = false,
        completed_at = NULL
      WHERE (r.state = 'in_flight' AND r.lease_expires_at <= clock_timestamp()
             AND r.fingerprint = EXCLUDED.fingerprint)
         OR (r.expires_at <= clock_timestamp()
             AND NOT (r.state = 'in_flight' AND r.lease_expires_at > clock_timestamp()))
      RETURNING fencing_token::text AS fencing_token, attempts`,

    classify: `
      SELECT state, fingerprint, response_status, response_headers, response_body, body_omitted,
             GREATEST(0, EXTRACT(EPOCH FROM (lease_expires_at - clock_timestamp())) * 1000)::float8
               AS lease_remaining_ms,
             expires_at <= clock_timestamp()
               AND NOT (state = 'in_flight' AND lease_expires_at > clock_timestamp())
               AS retention_expired
      FROM ${records}
      WHERE lookup_key = $1`,

    renew: `
      UPDATE ${records}
      SET lease_expires_at = clock_timestamp() + $3::bigint * interval '1 millisecond'
      WHERE lookup_key = $1 AND fencing_token = $2::bigint AND state = 'in_flight'`,

    complete: `
      UPDATE ${records}
      SET state = 'completed', response_status = $3, response_headers = $4::jsonb,
          response_body = $5, body_omitted = $6, completed_at = clock_timestamp(),
          lease_expires_at = NULL
      WHERE lookup_key = $1 AND fencing_token = $2::bigint AND state = 'in_flight'`,

    release: `
      DELETE FROM ${records}
      WHERE lookup_key = $1 AND fencing_token = $2::bigint AND state = 'in_flight'`,

    // SKIP LOCKED keeps a purge from waiting on rows a concurrent begin is updating.
    purge: `
      DELETE FROM ${records}
      WHERE lookup_key IN (
        SELECT lookup_key FROM ${records}
        WHERE expires_at <= clock_timestamp()
          AND NOT (state = 'in_flight' AND lease_expires_at > clock_timestamp())
        ORDER BY expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )`,
  };
}

function storedResponse(row: RecordRow): StoredResponse {
  return {
    status: row.response_status ?? 0,
    headers: row.response_headers ?? [],
    body: row.response_body === null ? null : new Uint8Array(row.response_body),
    bodyOmitted: row.body_omitted,
  };
}

/** pg sends bytea parameters as Buffers; this avoids copying when the input already is one. */
function bytes(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function isPgError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && "code" in error;
}
