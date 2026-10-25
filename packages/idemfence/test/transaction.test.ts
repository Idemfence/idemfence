import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdemfenceConfigError } from "../src/config.js";
import {
  type PostgresStore,
  postgresStore,
  type SqlExecutor,
} from "../src/stores/postgres/index.js";
import { databaseUrl, migrate } from "./support/postgres.js";

const url = databaseUrl();
const schema = `idemfence_tx_${randomBytes(4).toString("hex")}`;
const records = `"${schema}".idemfence_records`;
const orders = `"${schema}".orders`;

let pool: pg.Pool;
let store: PostgresStore;
/** A connection outside the pool, to observe what other sessions can see. */
let observer: pg.Client;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: url, max: 4 });
  await migrate(url, schema);
  await pool.query(`CREATE TABLE ${orders} (id text PRIMARY KEY)`);
  store = postgresStore({ pool, schema });
  await store.ready();
  observer = new pg.Client({ connectionString: url });
  await observer.connect();
});

afterAll(async () => {
  await observer.end();
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});

const key = (): Uint8Array => new Uint8Array(randomBytes(32));
const fp = new Uint8Array(32).fill(7);

async function visible(k: Uint8Array, orderId: string) {
  const record = await observer.query(
    `SELECT state FROM ${records} WHERE lookup_key = $1`,
    [Buffer.from(k)],
  );
  const order = await observer.query(`SELECT id FROM ${orders} WHERE id = $1`, [
    orderId,
  ]);
  return { record: record.rowCount, order: order.rowCount };
}

/**
 * Drives a store transaction the way the engine does: COMMIT when `fn` resolves; ROLLBACK
 * and rethrow `fn`'s rejection when it rejects.
 */
async function within<T>(
  on: PostgresStore,
  fn: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  const transaction = await on.openTransaction();
  let result: T;
  try {
    result = await fn(transaction.executor);
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  }
  await transaction.commit();
  return result;
}

describe("SqlExecutor", () => {
  it("is satisfied by a pg Pool and by a pg PoolClient", async () => {
    const fromPool: SqlExecutor = pool;
    const client = await pool.connect();
    try {
      const fromClient: SqlExecutor = client;
      const a = await fromPool.query<{ n: number }>("SELECT $1::int AS n", [1]);
      const b = await fromClient.query<{ n: number }>(
        "SELECT $1::int AS n",
        [2],
      );
      expect(a.rows[0]?.n).toBe(1);
      expect(a.rowCount).toBe(1);
      expect(b.rows[0]?.n).toBe(2);
    } finally {
      client.release();
    }
  });
});

describe("openTransaction", () => {
  it("commit() commits the handler's row and the store's record together", async () => {
    const k = key();
    const transaction = await store.openTransaction();
    const tx = transaction.executor;
    await tx.query(`INSERT INTO ${orders} (id) VALUES ($1)`, ["o-commit"]);
    const begun = await store.begin(k, fp, 5_000, 60_000, tx);
    expect(begun.outcome).toBe("acquired");
    // Uncommitted: invisible to another session.
    expect(await visible(k, "o-commit")).toEqual({ record: 0, order: 0 });
    await transaction.commit();
    expect(await visible(k, "o-commit")).toEqual({ record: 1, order: 1 });
  });

  it("rollback() discards both, and a caller that rethrows propagates the error unchanged", async () => {
    const k = key();
    const transaction = await store.openTransaction();
    const tx = transaction.executor;
    await tx.query(`INSERT INTO ${orders} (id) VALUES ($1)`, ["o-rollback"]);
    await store.begin(k, fp, 5_000, 60_000, tx);
    await expect(transaction.rollback()).resolves.toBeUndefined();
    expect(await visible(k, "o-rollback")).toEqual({ record: 0, order: 0 });

    // The same through the engine's pattern: the rejection comes back as thrown.
    const boom = new Error("handler failed");
    const k2 = key();
    await expect(
      within(store, async (tx2) => {
        await tx2.query(`INSERT INTO ${orders} (id) VALUES ($1)`, [
          "o-rollback-2",
        ]);
        await store.begin(k2, fp, 5_000, 60_000, tx2);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await visible(k2, "o-rollback-2")).toEqual({ record: 0, order: 0 });
  });

  it("leaves no lock_timeout from begin on the released connection", async () => {
    const single = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const connectionDefault = (
        await single.query<{ lock_timeout: string }>("SHOW lock_timeout")
      ).rows[0]?.lock_timeout;
      const singleStore = postgresStore({
        pool: single,
        schema,
        lockTimeout: "2s",
      });
      await within(singleStore, async (tx) => {
        await singleStore.begin(key(), fp, 5_000, 60_000, tx);
      });
      // max: 1, so this is the same connection the transaction ran on.
      const after = await single.query<{ lock_timeout: string }>(
        "SHOW lock_timeout",
      );
      expect(after.rows[0]?.lock_timeout).toBe(connectionDefault);
    } finally {
      await single.end();
    }
  });

  it("returns every client to the pool after mixed commits and rollbacks", async () => {
    const own = new pg.Pool({ connectionString: url, max: 4 });
    const ownStore = postgresStore({ pool: own, schema });
    try {
      await within(ownStore, async (tx) => {
        await tx.query("SELECT 1");
      });
      const start = { total: own.totalCount, idle: own.idleCount };
      expect(start).toEqual({ total: 1, idle: 1 });

      for (let i = 0; i < 100; i += 1) {
        const run = within(ownStore, async (tx) => {
          await tx.query(`INSERT INTO ${orders} (id) VALUES ($1)`, [
            `o-mixed-${i}`,
          ]);
          if (i % 3 === 0) {
            throw new Error(`rollback ${i}`);
          }
        });
        if (i % 3 === 0) {
          await expect(run).rejects.toThrow(`rollback ${i}`);
        } else {
          await run;
        }
      }
      expect({ total: own.totalCount, idle: own.idleCount }).toEqual(start);
      expect(own.waitingCount).toBe(0);
      const kept = await own.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${orders} WHERE id LIKE 'o-mixed-%'`,
      );
      expect(kept.rows[0]?.n).toBe(66);
    } finally {
      await own.end();
    }
  });

  it("destroys the client instead of returning it when ROLLBACK fails, and rollback() rejects", async () => {
    const own = new pg.Pool({ connectionString: url, max: 1 });
    const ownStore = postgresStore({ pool: own, schema });
    try {
      await own.query("SELECT 1");
      expect({ total: own.totalCount, idle: own.idleCount }).toEqual({
        total: 1,
        idle: 1,
      });

      const transaction = await ownStore.openTransaction();
      const tx = transaction.executor;
      const pid = (
        await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      // The handler is attached before yielding: the kill can reject the query while the
      // terminate round trip is still in flight.
      const sleeping = tx.query("SELECT pg_sleep(5)").then(
        () => "resolved",
        (error: unknown) => error,
      );
      await observer.query("SELECT pg_terminate_backend($1)", [pid]);
      expect(await sleeping).toMatchObject({ code: "57P01" });
      await expect(transaction.rollback()).rejects.toBeDefined();

      // The broken connection was destroyed, not put back for the next caller.
      expect({ total: own.totalCount, idle: own.idleCount }).toEqual({
        total: 0,
        idle: 0,
      });
      // And the pool still works: a fresh connection is made on demand.
      const fresh = await own.query<{ n: number }>("SELECT 1::int AS n");
      expect(fresh.rows[0]?.n).toBe(1);
    } finally {
      await own.end();
    }
  });

  it("rejects an invalid store lockTimeout with LOCK_TIMEOUT_INVALID at construction", () => {
    for (const lockTimeout of [0, -1, 1.5, "soon", "", 2_147_483_648, "0ms"]) {
      expect(() =>
        postgresStore({ pool, schema, lockTimeout } as {
          pool: pg.Pool;
          lockTimeout: "1s";
        }),
      ).toThrow(
        expect.objectContaining({
          name: "IdemfenceConfigError",
          code: "LOCK_TIMEOUT_INVALID",
        }),
      );
    }
    expect(() => postgresStore({ pool, schema, lockTimeout: "0ms" })).toThrow(
      IdemfenceConfigError,
    );
  });
});

describe("openTransaction when the backend dies", () => {
  it("leaves no unhandled error, no pool error and no broken client, wherever the kill lands", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    const own = new pg.Pool({ connectionString: url, max: 1 });
    const ownStore = postgresStore({ pool: own, schema });
    const poolErrors: unknown[] = [];
    own.on("error", (error) => {
      poolErrors.push(error);
    });
    const terminate = async (pid: number | undefined) => {
      await observer.query("SELECT pg_terminate_backend($1)", [pid]);
    };
    const pidOf = async (tx: SqlExecutor) =>
      (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]?.pid;

    const scenarios: Record<string, () => Promise<unknown>> = {
      // The kill is issued as soon as the client is handed out, racing BEGIN.
      "before BEGIN completes": () => {
        let killed: Promise<void> | undefined;
        own.once("acquire", (client) => {
          killed = terminate((client as { processID?: number }).processID);
        });
        return within(ownStore, async (tx) => {
          await killed;
          await tx.query("SELECT 1");
        });
      },
      "between statements": () =>
        within(ownStore, async (tx) => {
          await terminate(await pidOf(tx));
          await sleep(20);
          await tx.query("SELECT 1");
        }),
      "mid-statement": () =>
        within(ownStore, async (tx) => {
          const pid = await pidOf(tx);
          const sleeping = tx.query("SELECT pg_sleep(5)").then(
            () => "resolved",
            (error: unknown) => error,
          );
          await terminate(pid);
          expect(await sleeping).toMatchObject({ code: "57P01" });
          throw new Error("backend gone");
        }),
      "during COMMIT": () =>
        within(ownStore, async (tx) => {
          await terminate(await pidOf(tx));
        }),
    };

    try {
      for (let round = 0; round < 8; round += 1) {
        for (const [name, run] of Object.entries(scenarios)) {
          await expect(run(), `${name} #${round}`).rejects.toThrow();
          await sleep(30);
          expect(
            {
              name,
              round,
              total: own.totalCount,
              idle: own.idleCount,
              uncaught: uncaught.length,
              poolErrors: poolErrors.length,
            },
            `${name} #${round}`,
          ).toEqual({
            name,
            round,
            total: 0,
            idle: 0,
            uncaught: 0,
            poolErrors: 0,
          });
          const fresh = await own.query<{ n: number }>("SELECT 1::int AS n");
          expect(fresh.rows[0]?.n).toBe(1);
        }
      }
    } finally {
      process.off("uncaughtException", onUncaught);
      await own.end();
    }
  });
});

describe("openTransaction error classification", () => {
  it("TRANSACTION_UNAVAILABLE when the transaction cannot be opened", async () => {
    const dead = new pg.Pool({
      host: "127.0.0.1",
      port: 1,
      database: "none",
      user: "none",
      password: "none",
      connectionTimeoutMillis: 500,
    });
    dead.on("error", () => {});
    try {
      await expect(
        postgresStore({ pool: dead, schema }).openTransaction(),
      ).rejects.toEqual(
        expect.objectContaining({
          name: "IdemfenceStoreError",
          code: "TRANSACTION_UNAVAILABLE",
          cause: expect.any(Error),
        }),
      );
    } finally {
      await dead.end();
    }
  });

  it("COMMIT_REJECTED when the server answers COMMIT with an error (definite rollback)", async () => {
    await pool.query(
      `CREATE TABLE "${schema}".deferred (id int UNIQUE DEFERRABLE INITIALLY DEFERRED)`,
    );
    const transaction = await store.openTransaction();
    await transaction.executor.query(
      `INSERT INTO "${schema}".deferred (id) VALUES (1), (1)`,
    );
    await expect(transaction.commit()).rejects.toEqual(
      expect.objectContaining({
        name: "IdemfenceStoreError",
        code: "COMMIT_REJECTED",
        cause: expect.objectContaining({ code: "23505" }),
      }),
    );
    expect(
      (
        await observer.query(
          `SELECT count(*)::int AS n FROM "${schema}".deferred`,
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it("COMMIT_REJECTED when the transaction was already aborted and COMMIT answers ROLLBACK", async () => {
    // A failed statement that is swallowed leaves the transaction aborted; Postgres then
    // answers COMMIT with a ROLLBACK tag and no error.
    const transaction = await store.openTransaction();
    const tx = transaction.executor;
    await tx.query(`INSERT INTO ${orders} (id) VALUES ($1)`, ["o-aborted"]);
    await tx.query("SELECT 1 / 0").catch(() => undefined);
    await expect(transaction.commit()).rejects.toEqual(
      expect.objectContaining({
        name: "IdemfenceStoreError",
        code: "COMMIT_REJECTED",
      }),
    );
    expect(await visible(key(), "o-aborted")).toMatchObject({ order: 0 });
  });

  it("COMMIT_UNKNOWN when the connection fails during COMMIT (outcome ambiguous)", async () => {
    const own = new pg.Pool({ connectionString: url, max: 1 });
    own.on("error", () => {});
    try {
      const transaction = await postgresStore({
        pool: own,
        schema,
      }).openTransaction();
      const pid = (
        await transaction.executor.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        )
      ).rows[0]?.pid;
      // Returns once the backend is gone, so COMMIT reaches no server.
      await observer.query("SELECT pg_terminate_backend($1, 5000)", [pid]);
      await expect(transaction.commit()).rejects.toEqual(
        expect.objectContaining({
          name: "IdemfenceStoreError",
          code: "COMMIT_UNKNOWN",
          cause: expect.any(Error),
        }),
      );
      expect({ total: own.totalCount, idle: own.idleCount }).toEqual({
        total: 0,
        idle: 0,
      });
    } finally {
      await own.end();
    }
  });
});

describe("postgresStore.openTransaction", () => {
  it("opens a transaction without touching lock_timeout; begin scopes the store's lockTimeout to itself", async () => {
    const configured = postgresStore({ pool, schema, lockTimeout: "750ms" });
    expect(configured.lockTimeoutMs).toBe(750);
    expect(store.lockTimeoutMs).toBe(250);
    const k = key();
    const connectionDefault = (
      await pool.query<{ lock_timeout: string }>("SHOW lock_timeout")
    ).rows[0]?.lock_timeout;
    const transaction = await configured.openTransaction();
    const tx = transaction.executor;
    const shown = async () =>
      (await tx.query<{ lock_timeout: string }>("SHOW lock_timeout")).rows[0]
        ?.lock_timeout;
    expect(await shown()).toBe(connectionDefault);
    await tx.query("SET LOCAL lock_timeout = '3s'");
    const begun = await configured.begin(k, fp, 5_000, 60_000, tx);
    expect(begun.outcome).toBe("acquired");
    // Restored to exactly what was in effect before begin.
    expect(await shown()).toBe("3s");
    await tx.query(`INSERT INTO ${orders} (id) VALUES ($1)`, ["o-store-tx"]);
    await transaction.commit();
    expect(await visible(k, "o-store-tx")).toEqual({ record: 1, order: 1 });
    // The transaction has ended: its executor refuses to reach the connection.
    await expect(tx.query("SELECT 1")).rejects.toMatchObject({
      name: "IdemfenceStoreError",
      code: "TRANSACTION_ENDED",
    });
  });

  it("accepts the executor on renew, complete, release and purgeExpired", async () => {
    const k = key();
    const token = await within(store, async (tx) => {
      const begun = await store.begin(k, fp, 5_000, 60_000, tx);
      if (begun.outcome !== "acquired") {
        throw new Error(`unexpected ${begun.outcome}`);
      }
      expect(await store.renew(k, begun.fencingToken, 5_000, tx)).toBe(
        "renewed",
      );
      expect(
        await store.complete(
          k,
          begun.fencingToken,
          {
            status: 200,
            headers: [],
            body: new Uint8Array(0),
            bodyOmitted: false,
          },
          tx,
        ),
      ).toBe("completed");
      return begun.fencingToken;
    });
    expect(await visible(k, "none")).toMatchObject({ record: 1 });
    // Completed records cannot be released; a stale token is fenced.
    await within(store, async (tx) => {
      expect(await store.release(k, token, tx)).toBe("fenced");
      expect(await store.purgeExpired(10, tx)).toBe(0);
    });
  });
});
