// Transactional mode (docs/contract.md section 7, rows 5, 6, 8, 11, 13 and 14) end to end:
// real HTTP through the fetch adapter, a real Postgres, no mocked store, framework or clock.
// Waits synchronise on state (a handler gate the test controls, lock waits observed in
// pg_stat_activity), never on sleeps.
import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type LogFields,
  type Logger,
  type RouteConfig,
  resolveConfig,
  resolveRoute,
} from "../src/config.js";
import {
  type FetchRouteConfig,
  type Handler,
  idempotent,
} from "../src/fetch.js";
import { lookupKey } from "../src/hash.js";
import { createIdemfence, type Idemfence } from "../src/index.js";
import {
  type PostgresStore,
  postgresStore,
  type SqlExecutor,
} from "../src/stores/postgres/index.js";
import { databaseUrl, migrate } from "./support/postgres.js";

const url = databaseUrl();
const schema = `idemfence_txn_${randomBytes(4).toString("hex")}`;
const records = `"${schema}".idemfence_records`;
const orders = `"${schema}".orders`;
const SECRET = "transactional-test-secret-0123456789-abcd";
const DOCS = "https://example.com/docs/idempotency";

interface LogEntry {
  level: "warn" | "error";
  message: string;
  fields: LogFields;
}
const logs: LogEntry[] = [];
const logger: Logger = {
  warn: (message, fields) => {
    logs.push({ level: "warn", message, fields });
  },
  error: (message, fields) => {
    logs.push({ level: "error", message, fields });
  },
};

/** Pools created by tests; every one is ended after the file. */
const pools: pg.Pool[] = [];
let pool: pg.Pool;
/** A separate pool for observing: counts, records, pg_stat_activity. */
let observer: pg.Pool;
let server: ServerType;
let base: string;
const routes = new Map<string, (request: Request) => Promise<Response>>();

function newPool(config: pg.PoolConfig = {}): pg.Pool {
  const created = new pg.Pool({ connectionString: url, max: 10, ...config });
  created.on("error", () => {});
  pools.push(created);
  return created;
}

function idemfence(store: PostgresStore): Idemfence {
  return createIdemfence({
    store,
    scope: (request) => request.headers.get("x-principal") ?? undefined,
    secret: SECRET,
    docsUrl: DOCS,
    logger,
  });
}

beforeAll(async () => {
  pool = newPool();
  observer = newPool({ max: 2 });
  await migrate(url, schema);
  // All DDL happens here: DDL inside a test would wait on any transaction a failed test
  // left open.
  await pool.query(
    `CREATE TABLE ${orders} (id bigserial PRIMARY KEY, tag text NOT NULL)`,
  );
  await pool.query(
    `CREATE TABLE "${schema}".deferred_unique (id int UNIQUE DEFERRABLE INITIALLY DEFERRED)`,
  );
  // For COMMIT_UNKNOWN: a deferred constraint trigger fires inside COMMIT, after complete()
  // succeeded, and terminates its own backend there, so the connection fails during COMMIT
  // every time. Only a stored status of 218 sets it off.
  await pool.query(`
    CREATE FUNCTION "${schema}".die_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_terminate_backend(pg_backend_pid());
      PERFORM pg_sleep(30);
      RETURN NULL;
    END $$`);
  await pool.query(`
    CREATE CONSTRAINT TRIGGER die_at_commit AFTER UPDATE ON ${records}
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN (NEW.response_status = 218)
    EXECUTE FUNCTION "${schema}".die_at_commit()`);
  const app = new Hono();
  app.post("/r/:name", (c) => {
    const route = routes.get(c.req.param("name"));
    return route === undefined ? c.notFound() : route(c.req.raw);
  });
  await new Promise<void>((resolve) => {
    server = serve(
      { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
      (info) => {
        base = `http://127.0.0.1:${info.port}`;
        resolve();
      },
    );
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await Promise.all(pools.map((p) => p.end()));
});

let routeCounter = 0;
/**
 * Mounts `handler` (transactional by default) and returns its path, which is also its route
 * template unless `route` names one. `at` replaces the handler already mounted at that path.
 */
function mount(
  idem: Idemfence,
  handler: Handler,
  route: Partial<FetchRouteConfig> = {},
  at?: string,
): string {
  routeCounter += 1;
  const name = at?.slice("/r/".length) ?? `t${routeCounter}`;
  const routeTemplate = route.routeTemplate ?? `/r/${name}`;
  routes.set(
    name,
    idempotent(
      idem,
      { mode: "transactional", ...route, routeTemplate },
      handler,
    ),
  );
  return `/r/${name}`;
}

const freshKey = () => `k-${randomBytes(8).toString("hex")}`;
const freshTag = () => `tag-${randomBytes(6).toString("hex")}`;

interface Reply {
  status: number;
  headers: Headers;
  body: string;
  elapsedMs: number;
}

async function post(
  path: string,
  key: string | undefined,
  body = '{"item":"widget"}',
): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-principal": "user-1",
  };
  if (key !== undefined) {
    headers["idempotency-key"] = `"${key}"`;
  }
  const startedAt = performance.now();
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text,
    elapsedMs: performance.now() - startedAt,
  };
}

function expectProblem(reply: Reply, status: number, kind: string): void {
  expect(reply.status).toBe(status);
  expect(reply.headers.get("content-type")).toBe("application/problem+json");
  const body = JSON.parse(reply.body) as Record<string, unknown>;
  expect(body.status).toBe(status);
  if (kind === "about:blank") {
    expect(body.type).toBe("about:blank");
    expect(reply.headers.get("link")).toBeNull();
  } else {
    expect(body.type).toBe(`${DOCS}#${kind}`);
  }
  expect(reply.headers.get("idempotent-replayed")).toBeNull();
}

async function orderCount(tag: string): Promise<number> {
  const result = await observer.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${orders} WHERE tag = $1`,
    [tag],
  );
  return result.rows[0]?.n ?? -1;
}

async function record(
  key: string,
  routeTemplate: string,
): Promise<{ state: string; response_status: number | null } | undefined> {
  const lk = await lookupKey({
    namespace: "idemfence",
    principal: "user-1",
    method: "POST",
    routeTemplate,
    clientKey: key,
  });
  const result = await observer.query(
    `SELECT state, response_status FROM ${records} WHERE lookup_key = $1`,
    [Buffer.from(lk)],
  );
  return result.rows[0];
}

/** Resolves once `n` sessions are waiting on a lock in a statement on this file's records. */
async function lockWaiters(n: number): Promise<void> {
  for (;;) {
    const result = await observer.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND position($1 IN query) > 0`,
      [records],
    );
    if ((result.rows[0]?.n ?? 0) >= n) {
      return;
    }
    // Polling a state, not timing: the loop ends on the observed lock wait.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A handler that inserts one order through ctx.tx, then waits for the test's verdict. */
function gated(tag: string) {
  const started = deferred();
  const verdict = deferred<"commit" | "throw">();
  let calls = 0;
  const handler: Handler = async (_request, ctx) => {
    calls += 1;
    await ctx.tx?.query(`INSERT INTO ${orders} (tag) VALUES ($1)`, [tag]);
    if (calls === 1) {
      started.resolve();
      if ((await verdict.promise) === "throw") {
        throw new Error("the holder failed");
      }
    }
    return Response.json({ tag, call: calls }, { status: 201 });
  };
  return {
    handler,
    started: started.promise,
    release: verdict.resolve,
    calls: () => calls,
  };
}

const insertOrder = (tx: SqlExecutor | undefined, tag: string) =>
  tx?.query(`INSERT INTO ${orders} (tag) VALUES ($1)`, [tag]);

describe("transactional mode: outcomes (rows 5, 6, 11, 13)", () => {
  it("rows 5 and 6: the handler's insert and the record commit together; the replay is byte-identical", async () => {
    const tag = freshTag();
    const holder = gated(tag);
    const path = mount(
      idemfence(postgresStore({ pool, schema })),
      holder.handler,
    );
    const key = freshKey();

    const first = post(path, key);
    await holder.started;
    // Inside the handler: neither the order nor the record is visible to another session.
    expect(await orderCount(tag)).toBe(0);
    expect(await record(key, path)).toBeUndefined();
    holder.release("commit");
    const created = await first;
    expect(created.status).toBe(201);
    expect(created.headers.get("idempotent-replayed")).toBeNull();
    expect(await orderCount(tag)).toBe(1);
    expect(await record(key, path)).toEqual({
      state: "completed",
      response_status: 201,
    });

    const replay = await post(path, key);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.body).toBe(created.body);
    expect(holder.calls()).toBe(1);
    expect(await orderCount(tag)).toBe(1);
  });

  it("row 13: a throw after an insert is a 500 about:blank, not stored, and a retry runs the handler again", async () => {
    const tag = freshTag();
    let calls = 0;
    const path = mount(
      idemfence(postgresStore({ pool, schema })),
      async (_request, ctx) => {
        calls += 1;
        await insertOrder(ctx.tx, tag);
        throw new Error("after inserting");
      },
    );
    const key = freshKey();
    const mark = logs.length;

    const first = await post(path, key);
    expectProblem(first, 500, "about:blank");
    expect(await orderCount(tag)).toBe(0);
    expect(await record(key, path)).toBeUndefined();
    expect(logs.slice(mark)).toEqual([
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({ row: 13, outcome: "handler-error" }),
      }),
    ]);

    const retry = await post(path, key);
    expectProblem(retry, 500, "about:blank");
    expect(calls).toBe(2);
    expect(await orderCount(tag)).toBe(0);
    expect(await record(key, path)).toBeUndefined();
  });

  it("row 11: a release status after an insert is returned as-is with the insert and the record rolled back", async () => {
    const tag = freshTag();
    let calls = 0;
    const path = mount(
      idemfence(postgresStore({ pool, schema })),
      async (_request, ctx) => {
        calls += 1;
        await insertOrder(ctx.tx, tag);
        return new Response("later", {
          status: 429,
          headers: { "retry-after": "7", "x-own": "kept" },
        });
      },
    );
    const key = freshKey();

    const first = await post(path, key);
    expect(first.status).toBe(429);
    expect(first.body).toBe("later");
    expect(first.headers.get("retry-after")).toBe("7");
    expect(first.headers.get("x-own")).toBe("kept");
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect(await orderCount(tag)).toBe(0);
    expect(await record(key, path)).toBeUndefined();

    const retry = await post(path, key);
    expect(retry.status).toBe(429);
    expect(retry.headers.get("idempotent-replayed")).toBeNull();
    expect(calls).toBe(2);
    expect(await orderCount(tag)).toBe(0);
  });

  it("row 12 in transactional mode: a returned 5xx is committed and replayed", async () => {
    const tag = freshTag();
    let calls = 0;
    const path = mount(
      idemfence(postgresStore({ pool, schema })),
      async (_request, ctx) => {
        calls += 1;
        await insertOrder(ctx.tx, tag);
        return new Response("upstream failed", { status: 502 });
      },
    );
    const key = freshKey();
    const first = await post(path, key);
    expect(first.status).toBe(502);
    const replay = await post(path, key);
    expect(replay.status).toBe(502);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.body).toBe("upstream failed");
    expect(calls).toBe(1);
    expect(await orderCount(tag)).toBe(1);
  });

  it("row 7: a different body on a committed key is a 422 and writes nothing", async () => {
    const tag = freshTag();
    const path = mount(
      idemfence(postgresStore({ pool, schema })),
      async (_request, ctx) => {
        await insertOrder(ctx.tx, tag);
        return Response.json({ ok: true }, { status: 201 });
      },
    );
    const key = freshKey();
    expect((await post(path, key)).status).toBe(201);
    const reused = await post(path, key, '{"item":"gadget"}');
    expectProblem(reused, 422, "key-reused");
    expect(await orderCount(tag)).toBe(1);
  });
});

describe("transactional mode: a concurrent duplicate (row 8)", () => {
  for (const [lockTimeout, lockTimeoutMs, retryAfter] of [
    [undefined, 250, "1"],
    ["1500ms", 1_500, "2"],
  ] as const) {
    it(`waits the lock timeout (${lockTimeoutMs} ms), then is a 409 in-flight with Retry-After ${retryAfter}; a retry after the commit replays`, async () => {
      const tag = freshTag();
      const holder = gated(tag);
      const store = postgresStore({
        pool,
        schema,
        ...(lockTimeout === undefined ? {} : { lockTimeout }),
      });
      const path = mount(idemfence(store), holder.handler);
      const key = freshKey();

      const first = post(path, key);
      await holder.started;
      const duplicate = await post(path, key);
      expectProblem(duplicate, 409, "in-flight");
      expect(duplicate.headers.get("retry-after")).toBe(retryAfter);
      expect(duplicate.elapsedMs).toBeGreaterThanOrEqual(lockTimeoutMs);
      expect(holder.calls()).toBe(1);

      holder.release("commit");
      expect((await first).status).toBe(201);
      const retry = await post(path, key);
      expect(retry.status).toBe(201);
      expect(retry.headers.get("idempotent-replayed")).toBe("true");
      expect(holder.calls()).toBe(1);
      expect(await orderCount(tag)).toBe(1);
    });
  }

  it("when the holder throws while a duplicate waits, the duplicate acquires the key and runs the handler", async () => {
    const tag = freshTag();
    const holder = gated(tag);
    const path = mount(
      idemfence(postgresStore({ pool, schema, lockTimeout: "5s" })),
      holder.handler,
    );
    const key = freshKey();

    const first = post(path, key);
    await holder.started;
    const duplicate = post(path, key);
    await lockWaiters(1);
    holder.release("throw");
    expectProblem(await first, 500, "about:blank");
    const second = await duplicate;
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBeNull();
    expect(JSON.parse(second.body)).toEqual({ tag, call: 2 });
    expect(holder.calls()).toBe(2);
    expect(await orderCount(tag)).toBe(1);
    expect(await record(key, path)).toMatchObject({ state: "completed" });
  });

  for (const isolation of ["repeatable read", "serializable"]) {
    it(`under default_transaction_isolation ${isolation}, a holder committing during the wait (40001) is a 409; a retry replays`, async () => {
      const isolated = newPool({
        options: `-c default_transaction_isolation=${isolation.replace(" ", "\\ ")}`,
      });
      const shown = await isolated.query<{
        default_transaction_isolation: string;
      }>("SHOW default_transaction_isolation");
      expect(shown.rows[0]?.default_transaction_isolation).toBe(isolation);
      const tag = freshTag();
      const holder = gated(tag);
      const path = mount(
        idemfence(postgresStore({ pool: isolated, schema, lockTimeout: "5s" })),
        holder.handler,
      );
      const key = freshKey();

      const first = post(path, key);
      await holder.started;
      const duplicate = post(path, key);
      await lockWaiters(1);
      holder.release("commit");
      expect((await first).status).toBe(201);
      const conflicted = await duplicate;
      expectProblem(conflicted, 409, "in-flight");
      expect(conflicted.headers.get("retry-after")).toBe("5");
      // The commit ended the wait, long before the 5 s lock timeout.
      expect(conflicted.elapsedMs).toBeLessThan(4_000);
      expect(holder.calls()).toBe(1);

      const retry = await post(path, key);
      expect(retry.status).toBe(201);
      expect(retry.headers.get("idempotent-replayed")).toBe("true");
      expect(await orderCount(tag)).toBe(1);
    });
  }

  for (const [condition, sqlstate] of [
    ["serialization_failure", "40001"],
    ["lock_not_available", "55P03"],
  ] as const) {
    it(`a handler statement raising ${sqlstate} is a handler throw (row 13), not a 409`, async () => {
      const tag = freshTag();
      const path = mount(
        idemfence(postgresStore({ pool, schema })),
        async (_request, ctx) => {
          await insertOrder(ctx.tx, tag);
          await ctx.tx?.query(
            `DO $$ BEGIN RAISE EXCEPTION 'from the handler' USING ERRCODE = '${condition}'; END $$`,
          );
          return Response.json({ unreachable: true }, { status: 201 });
        },
      );
      const key = freshKey();
      const mark = logs.length;
      expectProblem(await post(path, key), 500, "about:blank");
      expect(logs.slice(mark)).toEqual([
        expect.objectContaining({
          fields: expect.objectContaining({
            row: 13,
            outcome: "handler-error",
            error: expect.objectContaining({ code: sqlstate }),
          }),
        }),
      ]);
      expect(await orderCount(tag)).toBe(0);
      expect(await record(key, path)).toBeUndefined();
    });
  }

  it("a committed lease-mode record still in flight is a 409 with the remaining lease (rollout)", async () => {
    const tag = freshTag();
    const store = postgresStore({ pool, schema });
    const idem = idemfence(store);
    const routeTemplate = `/shared-${randomBytes(4).toString("hex")}`;
    const started = deferred();
    const gate = deferred();
    const path = mount(
      idem,
      async () => {
        started.resolve();
        await gate.promise;
        return Response.json({ lease: true }, { status: 201 });
      },
      { routeTemplate, mode: "lease" },
    );
    const key = freshKey();
    const leased = post(path, key);
    await started.promise;
    // The same path, route template and body, now served in transactional mode.
    mount(
      idem,
      async (_request, ctx) => {
        await insertOrder(ctx.tx, tag);
        return Response.json({ tx: true }, { status: 201 });
      },
      { routeTemplate },
      path,
    );
    const reply = await post(path, key);
    expectProblem(reply, 409, "in-flight");
    // The 30 s default lease, not the 250 ms lock timeout.
    expect(Number(reply.headers.get("retry-after"))).toBeGreaterThan(20);
    gate.resolve();
    expect((await leased).status).toBe(201);
    expect(await orderCount(tag)).toBe(0);
  });
});

describe("transactional mode: lock_timeout scope (T3)", () => {
  it("the handler runs with the connection's own lock_timeout, and a duplicate still gets its 409 after the store's lock timeout", async () => {
    const fiveSeconds = newPool({ options: "-c lock_timeout=5s" });
    const tag = freshTag();
    const started = deferred();
    const gate = deferred();
    const seen: string[] = [];
    let calls = 0;
    const path = mount(
      idemfence(
        postgresStore({ pool: fiveSeconds, schema, lockTimeout: "1s" }),
      ),
      async (_request, ctx) => {
        calls += 1;
        const shown = await ctx.tx?.query<{ lock_timeout: string }>(
          "SHOW lock_timeout",
        );
        seen.push(shown?.rows[0]?.lock_timeout ?? "missing");
        await insertOrder(ctx.tx, tag);
        if (calls === 1) {
          started.resolve();
          await gate.promise;
        }
        return Response.json({ ok: true }, { status: 201 });
      },
    );
    const key = freshKey();
    const first = post(path, key);
    await started.promise;
    expect(seen).toEqual(["5s"]);

    const duplicate = await post(path, key);
    expectProblem(duplicate, 409, "in-flight");
    expect(duplicate.headers.get("retry-after")).toBe("1");
    expect(duplicate.elapsedMs).toBeGreaterThanOrEqual(1_000);
    // The store's 1 s, not the connection's 5 s.
    expect(duplicate.elapsedMs).toBeLessThan(4_000);

    gate.resolve();
    expect((await first).status).toBe(201);
    expect(calls).toBe(1);
  });
});

describe("transactional mode: one connection (T1)", () => {
  it("serves every outcome on a pool of one connection: the engine never takes a second", async () => {
    const single = newPool({ max: 1 });
    const idem = idemfence(postgresStore({ pool: single, schema }));
    const tag = freshTag();
    const inside: { total: number; idle: number; waiting: number }[] = [];
    const snapshot = () => {
      inside.push({
        total: single.totalCount,
        idle: single.idleCount,
        waiting: single.waitingCount,
      });
    };
    const created = mount(idem, async (_request, ctx) => {
      await insertOrder(ctx.tx, tag);
      snapshot();
      return Response.json({ ok: true }, { status: 201 });
    });
    const throws = mount(idem, async (_request, ctx) => {
      await insertOrder(ctx.tx, tag);
      snapshot();
      throw new Error("boom");
    });
    const release = mount(idem, async (_request, ctx) => {
      await insertOrder(ctx.tx, tag);
      snapshot();
      return new Response("later", { status: 429 });
    });
    const keyless = mount(
      idem,
      async (_request, ctx) => {
        await insertOrder(ctx.tx, tag);
        snapshot();
        return Response.json({ keyless: true });
      },
      { required: false },
    );
    // A hang (a second connection requested while the first is held) fails here.
    const bounded = (reply: Promise<Reply>) =>
      Promise.race([
        reply,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("hung on a one-connection pool")),
            5_000,
          ).unref();
        }),
      ]);
    const key = freshKey();
    expect((await bounded(post(created, key))).status).toBe(201);
    expect(
      (await bounded(post(created, key))).headers.get("idempotent-replayed"),
    ).toBe("true");
    expect((await bounded(post(created, key, '{"item":"other"}'))).status).toBe(
      422,
    );
    expect((await bounded(post(throws, freshKey()))).status).toBe(500);
    expect((await bounded(post(release, freshKey()))).status).toBe(429);
    expect((await bounded(post(keyless, undefined))).status).toBe(200);
    expect(inside).toEqual(
      Array.from({ length: 4 }, () => ({ total: 1, idle: 0, waiting: 0 })),
    );
    // The created order and the keyless one; the throw and the release rolled back.
    expect(await orderCount(tag)).toBe(2);
  });
});

describe("transactional mode: ctx.tx after the transaction (T6)", () => {
  it("rejects at once with TRANSACTION_ENDED after COMMIT and after ROLLBACK, and never reaches the pooled client", async () => {
    const single = newPool({ max: 1 });
    const idem = idemfence(postgresStore({ pool: single, schema }));
    const tag = freshTag();
    const kept: SqlExecutor[] = [];
    const committed = mount(idem, async (_request, ctx) => {
      if (ctx.tx !== undefined) {
        kept.push(ctx.tx);
      }
      return Response.json({ ok: true }, { status: 201 });
    });
    const rolledBack = mount(idem, async (_request, ctx) => {
      if (ctx.tx !== undefined) {
        kept.push(ctx.tx);
      }
      throw new Error("boom");
    });
    expect((await post(committed, freshKey())).status).toBe(201);
    expect((await post(rolledBack, freshKey())).status).toBe(500);
    expect(kept).toHaveLength(2);

    for (const tx of kept) {
      await expect(
        tx.query(`INSERT INTO ${orders} (tag) VALUES ($1)`, [tag]),
      ).rejects.toMatchObject({
        name: "IdemfenceStoreError",
        code: "TRANSACTION_ENDED",
      });
    }
    // The one pooled connection is back in the pool, idle outside any transaction, and
    // never saw the insert.
    expect({ total: single.totalCount, idle: single.idleCount }).toEqual({
      total: 1,
      idle: 1,
    });
    const pid = (
      await single.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]?.pid;
    const session = await observer.query<{ state: string }>(
      "SELECT state FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    expect(session.rows[0]?.state).toBe("idle");
    expect(await orderCount(tag)).toBe(0);
  });

  it("a handler that keeps ctx.tx and queries after returning gets the rejection", async () => {
    const tag = freshTag();
    const late = deferred<unknown>();
    const responded = deferred();
    const path = mount(
      idemfence(postgresStore({ pool, schema })),
      async (_request, ctx) => {
        const tx = ctx.tx;
        // Runs after the handler has returned and the transaction has been committed.
        setImmediate(() => {
          void responded.promise.then(() =>
            tx?.query(`INSERT INTO ${orders} (tag) VALUES ($1)`, [tag]).then(
              () => late.resolve("resolved"),
              (error: unknown) => late.resolve(error),
            ),
          );
        });
        return Response.json({ ok: true }, { status: 201 });
      },
    );
    const reply = await post(path, freshKey());
    responded.resolve();
    expect(reply.status).toBe(201);
    expect(await late.promise).toMatchObject({ code: "TRANSACTION_ENDED" });
    expect(await orderCount(tag)).toBe(0);
  });
});

describe("transactional mode: keyless request on an optional-key route (T7)", () => {
  it("runs the handler in a plain transaction with ctx.tx: committed when it resolves, no record", async () => {
    const tag = freshTag();
    let sawTx = false;
    const path = mount(
      idemfence(postgresStore({ pool, schema })),
      async (_request, ctx) => {
        sawTx = ctx.tx !== undefined;
        expect(ctx.renew).toBeUndefined();
        await insertOrder(ctx.tx, tag);
        return Response.json({ keyless: true }, { status: 201 });
      },
      { required: false },
    );
    const before = (
      await observer.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${records}`,
      )
    ).rows[0]?.n;
    const reply = await post(path, undefined);
    expect(reply.status).toBe(201);
    expect(reply.headers.get("idempotent-replayed")).toBeNull();
    expect(sawTx).toBe(true);
    expect(await orderCount(tag)).toBe(1);
    const after = (
      await observer.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${records}`,
      )
    ).rows[0]?.n;
    expect(after).toBe(before);
  });

  it("rolls the plain transaction back and rethrows when the handler throws", async () => {
    const tag = freshTag();
    const path = mount(
      idemfence(postgresStore({ pool, schema })),
      async (_request, ctx) => {
        await insertOrder(ctx.tx, tag);
        throw new Error("keyless failure");
      },
      { required: false },
    );
    const reply = await post(path, undefined);
    // The throw reached the framework (Hono's default 500), not an idemfence problem.
    expect(reply.status).toBe(500);
    expect(reply.headers.get("content-type")).not.toBe(
      "application/problem+json",
    );
    expect(await orderCount(tag)).toBe(0);
  });
});

describe("transactional mode: configuration (T8)", () => {
  it("rejects failOpen: true with mode: transactional (FAIL_OPEN_TRANSACTIONAL)", async () => {
    const store = postgresStore({ pool, schema });
    const config = resolveConfig({
      store,
      scope: () => "user-1",
      secret: SECRET,
      docsUrl: DOCS,
    });
    const both: RouteConfig = {
      routeTemplate: "/orders",
      mode: "transactional",
      failOpen: true,
    };
    expect(() => resolveRoute(config, both)).toThrow(
      expect.objectContaining({
        name: "IdemfenceConfigError",
        code: "FAIL_OPEN_TRANSACTIONAL",
      }),
    );
    // Each alone is accepted.
    expect(
      resolveRoute(config, { routeTemplate: "/orders", failOpen: true })
        .failOpen,
    ).toBe(true);
    expect(
      resolveRoute(config, { routeTemplate: "/orders", mode: "transactional" })
        .mode,
    ).toBe("transactional");
    // And on first use through the engine.
    await expect(
      idemfence(store).handle(
        new Request("https://api.example.com/orders", {
          method: "POST",
          headers: { "idempotency-key": `"${freshKey()}"`, "x-principal": "u" },
          body: "{}",
        }),
        both,
        async () => new Response("never"),
      ),
    ).rejects.toMatchObject({ code: "FAIL_OPEN_TRANSACTIONAL" });
  });
});

describe("transactional mode: store failures after the handler (section 5)", () => {
  it("a handler that swallows a failed statement leaves the transaction aborted: 503, nothing committed", async () => {
    const tag = freshTag();
    const path = mount(
      idemfence(postgresStore({ pool, schema })),
      async (_request, ctx) => {
        await insertOrder(ctx.tx, tag);
        await ctx.tx?.query("SELECT 1 / 0").catch(() => undefined);
        return Response.json({ looks: "fine" }, { status: 201 });
      },
    );
    const key = freshKey();
    const reply = await post(path, key);
    expectProblem(reply, 503, "store-unavailable");
    expect(reply.headers.get("retry-after")).toBe("5");
    expect(reply.body).not.toContain("looks");
    expect(await orderCount(tag)).toBe(0);
    expect(await record(key, path)).toBeUndefined();
  });

  it("COMMIT_REJECTED (a deferred constraint fails at COMMIT): 503, nothing committed", async () => {
    const tag = freshTag();
    const path = mount(
      idemfence(postgresStore({ pool, schema })),
      async (_request, ctx) => {
        await insertOrder(ctx.tx, tag);
        await ctx.tx?.query(
          `INSERT INTO "${schema}".deferred_unique (id) VALUES (1), (1)`,
        );
        return Response.json({ ok: true }, { status: 201 });
      },
    );
    const key = freshKey();
    const mark = logs.length;
    const reply = await post(path, key);
    expectProblem(reply, 503, "store-unavailable");
    expect(await orderCount(tag)).toBe(0);
    expect(await record(key, path)).toBeUndefined();
    expect(logs.slice(mark)).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({
          row: 14,
          outcome: "store-unavailable",
          error: expect.objectContaining({ code: "COMMIT_REJECTED" }),
        }),
      }),
    ]);
  });

  it("COMMIT_UNKNOWN (the backend dies during COMMIT): 503, and no record afterwards", async () => {
    // Status 218 sets off the die_at_commit trigger created in beforeAll.
    const own = newPool({ max: 1 });
    const tag = freshTag();
    const path = mount(
      idemfence(postgresStore({ pool: own, schema })),
      async (_request, ctx) => {
        await insertOrder(ctx.tx, tag);
        return new Response("fatal at commit", { status: 218 });
      },
    );
    const key = freshKey();
    const mark = logs.length;
    const reply = await post(path, key);
    expectProblem(reply, 503, "store-unavailable");
    expect(reply.headers.get("retry-after")).toBe("5");
    expect(logs.slice(mark)).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({
          row: 14,
          outcome: "store-unavailable",
          error: expect.objectContaining({ code: "COMMIT_UNKNOWN" }),
        }),
      }),
    ]);
    // The trigger ran before the commit record: nothing landed, and the key is free.
    expect(await record(key, path)).toBeUndefined();
    expect(await orderCount(tag)).toBe(0);
    // The broken connection was destroyed, not returned to the pool.
    expect({ total: own.totalCount, idle: own.idleCount }).toEqual({
      total: 0,
      idle: 0,
    });
  });
});
