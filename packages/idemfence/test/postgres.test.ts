import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IdemfenceStoreError,
  postgresStore,
  type Store,
  type StoredResponse,
} from "../src/stores/postgres/index.js";

const MIGRATION = new URL("../migrations/001_init.sql", import.meta.url);

const url = process.env.IDEMFENCE_TEST_DATABASE_URL;
if (url === undefined || url === "") {
  throw new Error(
    "IDEMFENCE_TEST_DATABASE_URL is not set. The store tests need a real Postgres; see CONTRIBUTING.md.",
  );
}

const schema = `idemfence_test_${randomBytes(4).toString("hex")}`;
const records = `"${schema}".idemfence_records`;
let pool: pg.Pool;
let store: Store;

/** Applies the migration to `target` on a dedicated connection, so pooled sessions keep their search_path. */
async function migrate(target: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${target}"`);
    await client.query(`SET search_path TO "${target}"`);
    await client.query(await readFile(MIGRATION, "utf8"));
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: url, max: 20 });
  await migrate(schema);
  // The default-schema test needs the tables in public; CI applies them with psql first.
  const inPublic = await pool.query(
    "SELECT to_regclass('public.idemfence_meta') AS t",
  );
  if (inPublic.rows[0].t === null) {
    await migrate("public");
  }
  store = postgresStore({ pool, schema });
  await store.ready();
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});

const key = (): Uint8Array => new Uint8Array(randomBytes(32));
const fp = (seed = 0): Uint8Array => new Uint8Array(32).fill(seed);
const LEASE = 5_000;
const RETENTION = 60_000;

const response: StoredResponse = {
  status: 201,
  headers: [
    ["content-type", "application/json"],
    ["location", "/orders/42"],
  ],
  body: new TextEncoder().encode('{"id":42}'),
  bodyOmitted: false,
};

async function acquire(
  k: Uint8Array,
  f = fp(),
  lease = LEASE,
  retention = RETENTION,
) {
  const result = await store.begin(k, f, lease, retention);
  if (result.outcome !== "acquired") {
    throw new Error(`expected acquired, got ${result.outcome}`);
  }
  return result;
}

async function row(k: Uint8Array) {
  const result = await pool.query(
    `SELECT state, fencing_token::text AS fencing_token, attempts,
            lease_expires_at IS NOT NULL AS has_lease, completed_at IS NOT NULL AS completed
     FROM ${records} WHERE lookup_key = $1`,
    [Buffer.from(k)],
  );
  return result.rows[0];
}

describe("schema", () => {
  it("ready() accepts schema version 1, including in the default schema", async () => {
    await expect(store.ready()).resolves.toBeUndefined();
    await expect(postgresStore({ pool }).ready()).resolves.toBeUndefined();
  });

  it("ready() rejects a different schema version", async () => {
    const other = `${schema}_v2`;
    await migrate(other);
    await pool.query(`UPDATE "${other}".idemfence_meta SET version = 2`);
    const error = await postgresStore({ pool, schema: other })
      .ready()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(IdemfenceStoreError);
    expect((error as IdemfenceStoreError).code).toBe("SCHEMA_VERSION_MISMATCH");
    await pool.query(`DROP SCHEMA "${other}" CASCADE`);
  });

  it("ready() rejects a schema without the tables", async () => {
    const empty = `${schema}_empty`;
    await pool.query(`CREATE SCHEMA "${empty}"`);
    const error = await postgresStore({ pool, schema: empty })
      .ready()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((error as IdemfenceStoreError).code).toBe("SCHEMA_VERSION_MISMATCH");
    await pool.query(`DROP SCHEMA "${empty}" CASCADE`);
  });

  it("rejects an invalid schema name", () => {
    for (const bad of ["Public", 'a"b', "1abc", "a-b", "x".repeat(64), ""]) {
      expect(() => postgresStore({ pool, schema: bad })).toThrow(
        expect.objectContaining({ code: "SCHEMA_NAME_INVALID" }),
      );
    }
  });

  it("the tables are LOGGED", async () => {
    const result = await pool.query(
      `SELECT c.relname, c.relpersistence FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
      [schema],
    );
    expect(result.rows).toStrictEqual([
      { relname: "idemfence_meta", relpersistence: "p" },
      { relname: "idemfence_records", relpersistence: "p" },
    ]);
  });

  it("rejects keys and fingerprints that are not 32 bytes", async () => {
    const check = expect.objectContaining({ code: "23514" });
    await expect(
      store.begin(new Uint8Array(31), fp(), LEASE, RETENTION),
    ).rejects.toEqual(check);
    await expect(
      store.begin(new Uint8Array(33), fp(), LEASE, RETENTION),
    ).rejects.toEqual(check);
    await expect(
      store.begin(key(), new Uint8Array(31), LEASE, RETENTION),
    ).rejects.toEqual(check);
  });
});

describe("begin", () => {
  it("acquires a lease for a new key", async () => {
    const k = key();
    const result = await acquire(k);
    expect(result.attempts).toBe(1);
    expect(typeof result.fencingToken).toBe("bigint");
    expect(await row(k)).toMatchObject({
      state: "in_flight",
      attempts: 1,
      has_lease: true,
    });
  });

  it("replays a completed key with the same fingerprint", async () => {
    const k = key();
    const { fencingToken } = await acquire(k);
    expect(await store.complete(k, fencingToken, response)).toBe("completed");

    expect(await store.begin(k, fp(), LEASE, RETENTION)).toStrictEqual({
      outcome: "replay",
      response,
    });
    expect(await row(k)).toMatchObject({
      state: "completed",
      completed: true,
      has_lease: false,
    });
  });

  it("replays an omitted body as null", async () => {
    const k = key();
    const { fencingToken } = await acquire(k);
    const omitted: StoredResponse = {
      ...response,
      body: null,
      bodyOmitted: true,
    };
    await store.complete(k, fencingToken, omitted);
    expect(await store.begin(k, fp(), LEASE, RETENTION)).toStrictEqual({
      outcome: "replay",
      response: omitted,
    });
  });

  it("reports a mismatch for a completed key with a different fingerprint", async () => {
    const k = key();
    const { fencingToken } = await acquire(k);
    await store.complete(k, fencingToken, response);
    expect(await store.begin(k, fp(1), LEASE, RETENTION)).toStrictEqual({
      outcome: "mismatch",
    });
    expect(await row(k)).toMatchObject({ state: "completed" });
  });

  it("reports a mismatch for an in-flight key with a different fingerprint", async () => {
    const k = key();
    await acquire(k);
    expect(await store.begin(k, fp(1), LEASE, RETENTION)).toStrictEqual({
      outcome: "mismatch",
    });
  });

  it("reports in-flight with the remaining lease for a live lease and the same fingerprint", async () => {
    const k = key();
    await acquire(k, fp(), 2_000);
    const result = await store.begin(k, fp(), LEASE, RETENTION);
    expect(result.outcome).toBe("in_flight");
    if (result.outcome === "in_flight") {
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(2_000);
      expect(Number.isInteger(result.retryAfterMs)).toBe(true);
    }
    expect(await row(k)).toMatchObject({ attempts: 1 });
  });

  it("takes over an expired lease with a new fencing token and fences the old holder", async () => {
    const k = key();
    const first = await acquire(k, fp(), 200);
    await sleep(350);

    const second = await acquire(k, fp(), LEASE);
    expect(second.fencingToken).toBe(first.fencingToken + 1n);
    expect(second.attempts).toBe(2);

    expect(await store.renew(k, first.fencingToken, LEASE)).toBe("fenced");
    expect(await store.complete(k, first.fencingToken, response)).toBe(
      "fenced",
    );
    expect(await store.release(k, first.fencingToken)).toBe("fenced");
    expect(await row(k)).toMatchObject({ state: "in_flight", attempts: 2 });

    expect(await store.complete(k, second.fencingToken, response)).toBe(
      "completed",
    );
  });

  it("treats a key past retention as a first request", async () => {
    const k = key();
    const first = await acquire(k, fp(), 100, 250);
    await store.complete(k, first.fencingToken, response);
    await sleep(350);

    const again = await acquire(k, fp(1), LEASE, RETENTION);
    expect(again.attempts).toBe(1);
    expect(again.fencingToken).toBeGreaterThan(first.fencingToken);
    expect(await row(k)).toMatchObject({
      state: "in_flight",
      attempts: 1,
      completed: false,
    });
  });

  it("acquires exactly once across 50 concurrent begins on one key", async () => {
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => store.begin(k, fp(), LEASE, RETENTION)),
    );
    const outcomes = results.map((r) => r.outcome);
    expect(outcomes.filter((o) => o === "acquired")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "in_flight")).toHaveLength(49);
    const count = await pool.query(
      `SELECT count(*)::int AS n FROM ${records} WHERE lookup_key = $1`,
      [Buffer.from(k)],
    );
    expect(count.rows[0].n).toBe(1);
    expect(await row(k)).toMatchObject({ attempts: 1 });
  });
});

describe("renew and release", () => {
  it("renew extends a lease so it is not taken over", async () => {
    const k = key();
    const { fencingToken } = await acquire(k, fp(), 200);
    expect(await store.renew(k, fencingToken, 5_000)).toBe("renewed");
    await sleep(350);
    expect((await store.begin(k, fp(), LEASE, RETENTION)).outcome).toBe(
      "in_flight",
    );
  });

  it("release deletes the record so the key can be acquired again", async () => {
    const k = key();
    const { fencingToken } = await acquire(k);
    expect(await store.release(k, fencingToken)).toBe("released");
    expect(await row(k)).toBeUndefined();
    expect((await store.begin(k, fp(1), LEASE, RETENTION)).outcome).toBe(
      "acquired",
    );
  });

  it("complete and release are fenced after the record was completed", async () => {
    const k = key();
    const { fencingToken } = await acquire(k);
    await store.complete(k, fencingToken, response);
    expect(await store.complete(k, fencingToken, response)).toBe("fenced");
    expect(await store.renew(k, fencingToken, LEASE)).toBe("fenced");
    expect(await store.release(k, fencingToken)).toBe("fenced");
  });

  it("a stale token never matches a record recreated after release", async () => {
    const k = key();
    const a = await acquire(k, fp(), 200);
    await sleep(350);
    const b = await acquire(k, fp(), LEASE);
    expect(await store.release(k, b.fencingToken)).toBe("released");
    const c = await acquire(k, fp(), LEASE);

    expect(c.fencingToken).toBeGreaterThan(b.fencingToken);
    expect(await store.complete(k, a.fencingToken, response)).toBe("fenced");
    expect(await store.complete(k, b.fencingToken, response)).toBe("fenced");
    expect(await store.complete(k, c.fencingToken, response)).toBe("completed");
  });
});

describe("the vanished-row race", () => {
  type Hook = (text: string, rowCount: number | null) => Promise<void>;

  /** The real pool, with a hook run after each statement; the store is untouched. */
  function hooked(hook: Hook): pg.Pool {
    return new Proxy(pool, {
      get(target, property, receiver) {
        if (property !== "query") {
          return Reflect.get(target, property, receiver);
        }
        return async (text: string, values?: unknown[]) => {
          const result = await target.query(text, values);
          await hook(text, result.rowCount);
          return result;
        };
      },
    });
  }

  it("retries begin when the row is deleted between the two statements", async () => {
    const k = key();
    const { fencingToken } = await acquire(k);
    await store.complete(k, fencingToken, response);

    let deletions = 0;
    const racy = postgresStore({
      schema,
      pool: hooked(async (text, rowCount) => {
        if (text.includes("INSERT INTO") && rowCount === 0) {
          deletions += 1;
          await pool.query(`DELETE FROM ${records} WHERE lookup_key = $1`, [
            Buffer.from(k),
          ]);
        }
      }),
    });

    const result = await racy.begin(k, fp(1), LEASE, RETENTION);
    expect(result.outcome).toBe("acquired");
    expect(deletions).toBe(1);
  });

  it("gives up after three attempts", async () => {
    const k = key();
    const { fencingToken } = await acquire(k);
    await store.complete(k, fencingToken, response);

    let inserts = 0;
    const racy = postgresStore({
      schema,
      pool: hooked(async (text, rowCount) => {
        if (text.includes("INSERT INTO") && rowCount === 0) {
          inserts += 1;
          await pool.query(`DELETE FROM ${records} WHERE lookup_key = $1`, [
            Buffer.from(k),
          ]);
        } else if (text.includes("SELECT state") && rowCount === 0) {
          // Put a completed record back so the next insert conflicts again.
          const again = await acquire(k);
          await store.complete(k, again.fencingToken, response);
        }
      }),
    });

    await expect(racy.begin(k, fp(1), LEASE, RETENTION)).rejects.toEqual(
      expect.objectContaining({
        name: "IdemfenceStoreError",
        code: "BEGIN_RACE_EXHAUSTED",
      }),
    );
    expect(inserts).toBe(3);
  });
});

describe("purgeExpired", () => {
  it("deletes at most `limit` expired records and never a live lease", async () => {
    const expired: Uint8Array[] = [];
    for (let i = 0; i < 5; i += 1) {
      const k = key();
      const { fencingToken } = await acquire(k);
      await store.complete(k, fencingToken, response);
      expired.push(k);
    }
    const live = key();
    await acquire(live);
    const past = [...expired, live].map((k) => Buffer.from(k));
    // Push every record past retention; the live one keeps its valid lease.
    await pool.query(
      `UPDATE ${records} SET expires_at = clock_timestamp() - interval '1 second' WHERE lookup_key = ANY($1)`,
      [past],
    );

    expect(await store.purgeExpired(3)).toBe(3);
    expect(await store.purgeExpired(10)).toBe(2);
    expect(await store.purgeExpired(10)).toBe(0);
    const remaining = await pool.query(
      `SELECT lookup_key FROM ${records} WHERE lookup_key = ANY($1)`,
      [past],
    );
    expect(remaining.rows.map((r) => r.lookup_key)).toStrictEqual([
      Buffer.from(live),
    ]);
  });
});
