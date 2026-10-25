import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdemfenceConfigError } from "../src/config.js";
import {
  type PostgresStore,
  postgresStore,
  type SqlExecutor,
  withTransaction,
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

describe("withTransaction", () => {
  it("commits the handler's row and the store's record together", async () => {
    const k = key();
    const result = await withTransaction(pool, {}, async (tx) => {
      await tx.query(`INSERT INTO ${orders} (id) VALUES ($1)`, ["o-commit"]);
      const begun = await store.begin(k, fp, 5_000, 60_000, tx);
      expect(begun.outcome).toBe("acquired");
      // Uncommitted: invisible to another session.
      expect(await visible(k, "o-commit")).toEqual({ record: 0, order: 0 });
      return "done";
    });
    expect(result).toBe("done");
    expect(await visible(k, "o-commit")).toEqual({ record: 1, order: 1 });
  });

  it("rolls both back when the function throws, and propagates the error", async () => {
    const k = key();
    const boom = new Error("handler failed");
    await expect(
      withTransaction(pool, {}, async (tx) => {
        await tx.query(`INSERT INTO ${orders} (id) VALUES ($1)`, [
          "o-rollback",
        ]);
        await store.begin(k, fp, 5_000, 60_000, tx);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await visible(k, "o-rollback")).toEqual({ record: 0, order: 0 });
  });

  it("sets lock_timeout locally (default 250 ms) and leaves none on the released connection", async () => {
    const single = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const inside = await withTransaction(single, {}, async (tx) => {
        const shown = await tx.query<{ lock_timeout: string }>(
          "SHOW lock_timeout",
        );
        return shown.rows[0]?.lock_timeout;
      });
      expect(inside).toBe("250ms");

      const custom = await withTransaction(
        single,
        { lockTimeout: "2s" },
        async (tx) =>
          (await tx.query<{ lock_timeout: string }>("SHOW lock_timeout"))
            .rows[0]?.lock_timeout,
      );
      expect(custom).toBe("2s");

      // max: 1, so this is the same connection the transactions ran on.
      const after = await single.query<{ lock_timeout: string }>(
        "SHOW lock_timeout",
      );
      expect(after.rows[0]?.lock_timeout).toBe("0");
    } finally {
      await single.end();
    }
  });

  it("returns every client to the pool after mixed commits and rollbacks", async () => {
    const own = new pg.Pool({ connectionString: url, max: 4 });
    try {
      await withTransaction(own, {}, async (tx) => {
        await tx.query("SELECT 1");
      });
      const start = { total: own.totalCount, idle: own.idleCount };
      expect(start).toEqual({ total: 1, idle: 1 });

      for (let i = 0; i < 100; i += 1) {
        const run = withTransaction(own, {}, async (tx) => {
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

  it("destroys the client instead of returning it when ROLLBACK fails", async () => {
    const own = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await own.query("SELECT 1");
      expect({ total: own.totalCount, idle: own.idleCount }).toEqual({
        total: 1,
        idle: 1,
      });

      await expect(
        withTransaction(own, {}, async (tx) => {
          const pid = (
            await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]?.pid;
          // The handler is attached before yielding: the kill can reject the query while
          // the terminate round trip is still in flight.
          const sleeping = tx.query("SELECT pg_sleep(5)").then(
            () => "resolved",
            (error: unknown) => error,
          );
          await observer.query("SELECT pg_terminate_backend($1)", [pid]);
          const settled = await sleeping;
          expect(settled).toMatchObject({ code: "57P01" });
          throw new Error("backend gone");
        }),
      ).rejects.toThrow("backend gone");

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

  it("rejects an invalid lockTimeout with LOCK_TIMEOUT_INVALID before taking a client", async () => {
    for (const lockTimeout of [0, -1, 1.5, "soon", "", 2_147_483_648]) {
      await expect(
        withTransaction(
          pool,
          { lockTimeout } as { lockTimeout: "1s" },
          async () => {},
        ),
      ).rejects.toEqual(
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

describe("withTransaction when the backend dies", () => {
  it("leaves no unhandled error, no pool error and no broken client, wherever the kill lands", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    const own = new pg.Pool({ connectionString: url, max: 1 });
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
      // The kill is issued as soon as the client is handed out, racing BEGIN and SET LOCAL.
      "before BEGIN completes": () => {
        let killed: Promise<void> | undefined;
        own.once("acquire", (client) => {
          killed = terminate((client as { processID?: number }).processID);
        });
        return withTransaction(own, {}, async (tx) => {
          await killed;
          await tx.query("SELECT 1");
        });
      },
      "between statements": () =>
        withTransaction(own, {}, async (tx) => {
          await terminate(await pidOf(tx));
          await sleep(20);
          await tx.query("SELECT 1");
        }),
      "mid-statement": () =>
        withTransaction(own, {}, async (tx) => {
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
        withTransaction(own, {}, async (tx) => {
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

describe("withTransaction error classification", () => {
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
      await expect(withTransaction(dead, {}, async () => {})).rejects.toEqual(
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
    await expect(
      withTransaction(pool, {}, async (tx) => {
        await tx.query(`INSERT INTO "${schema}".deferred (id) VALUES (1), (1)`);
      }),
    ).rejects.toEqual(
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

  it("COMMIT_UNKNOWN when the connection fails during COMMIT (outcome ambiguous)", async () => {
    const own = new pg.Pool({ connectionString: url, max: 1 });
    own.on("error", () => {});
    try {
      await expect(
        withTransaction(own, {}, async (tx) => {
          const pid = (
            await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]?.pid;
          await observer.query("SELECT pg_terminate_backend($1)", [pid]);
          // Let the client process the FATAL before COMMIT is attempted.
          await sleep(50);
        }),
      ).rejects.toEqual(
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

describe("postgresStore.transaction", () => {
  it("runs the function in a transaction with the store's lockTimeout", async () => {
    const configured = postgresStore({ pool, schema, lockTimeout: "750ms" });
    expect(configured.lockTimeoutMs).toBe(750);
    expect(store.lockTimeoutMs).toBe(250);
    const k = key();
    await configured.transaction(async (tx) => {
      const shown = await tx.query<{ lock_timeout: string }>(
        "SHOW lock_timeout",
      );
      expect(shown.rows[0]?.lock_timeout).toBe("750ms");
      await configured.begin(k, fp, 5_000, 60_000, tx);
      await tx.query(`INSERT INTO ${orders} (id) VALUES ($1)`, ["o-store-tx"]);
    });
    expect(await visible(k, "o-store-tx")).toEqual({ record: 1, order: 1 });
  });

  it("accepts the executor on renew, complete, release and purgeExpired", async () => {
    const k = key();
    const token = await withTransaction(pool, {}, async (tx) => {
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
    await withTransaction(pool, {}, async (tx) => {
      expect(await store.release(k, token, tx)).toBe("fenced");
      expect(await store.purgeExpired(10, tx)).toBe(0);
    });
  });
});
