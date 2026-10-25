// Lease heartbeat, maxHold and ctx.signal (docs/contract.md section 7, rows 8, 9 and 16) end
// to end: real HTTP through the fetch adapter, a real Postgres, no mocked store, framework
// or clock. A stalled holder is a real process frozen with SIGSTOP (support/child.ts). Waits
// poll state (the store's clock, a handler gate, child events), each with a deadline.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type IdemfenceOptions,
  type LogFields,
  type Logger,
  resolveConfig,
  resolveRoute,
} from "../src/config.js";
import {
  type FetchRouteConfig,
  type Handler,
  idempotent,
} from "../src/fetch.js";
import { lookupKey } from "../src/hash.js";
import {
  createIdemfence,
  type Idemfence,
  IdemfenceFencedError,
  IdemfenceHoldLimitError,
  type TransactionalStore,
} from "../src/index.js";
import {
  type PostgresStore,
  postgresStore,
} from "../src/stores/postgres/index.js";
import { type ChildServer, startChildServer } from "./support/child.js";
import { databaseUrl, migrate } from "./support/postgres.js";

const url = databaseUrl();
const schema = `idemfence_hb_${randomBytes(4).toString("hex")}`;
const records = `"${schema}".idemfence_records`;
const SECRET = "heartbeat-test-secret-0123456789-abcdefgh";
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

const pools: pg.Pool[] = [];
let pool: pg.Pool;
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

function idemfence(
  options: Partial<IdemfenceOptions<Request>> = {},
): Idemfence {
  return createIdemfence({
    store: postgresStore({ pool, schema }),
    scope: (request) => request.headers.get("x-principal") ?? undefined,
    secret: SECRET,
    docsUrl: DOCS,
    logger,
    ...options,
  });
}

beforeAll(async () => {
  pool = newPool();
  observer = newPool({ max: 2 });
  await migrate(url, schema);
  const app = new Hono();
  app.on(["POST", "GET"], "*", (c) => {
    const route = routes.get(new URL(c.req.url).pathname);
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
const freshPath = () => {
  routeCounter += 1;
  return `/h-${routeCounter}-${randomBytes(3).toString("hex")}`;
};

/** Mounts `handler` at `path` (route template = path) and returns the path. */
function mount(
  idem: Idemfence,
  handler: Handler,
  route: Partial<FetchRouteConfig> = {},
  path = freshPath(),
): string {
  routes.set(
    path,
    idempotent(idem, { routeTemplate: path, ...route }, handler),
  );
  return path;
}

const freshKey = () => `k-${randomBytes(8).toString("hex")}`;

interface Reply {
  status: number;
  headers: Headers;
  body: string;
}

async function post(
  target: string,
  key: string | undefined,
  init: { signal?: AbortSignal; method?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { "x-principal": "user-1" };
  if (key !== undefined) {
    headers["idempotency-key"] = `"${key}"`;
  }
  const method = init.method ?? "POST";
  if (method !== "GET") {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(
    target.startsWith("http") ? target : `${base}${target}`,
    {
      method,
      headers,
      ...(method === "GET" ? {} : { body: '{"item":"widget"}' }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    },
  );
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

async function lookup(path: string, key: string): Promise<Buffer> {
  return Buffer.from(
    await lookupKey({
      namespace: "idemfence",
      principal: "user-1",
      method: "POST",
      routeTemplate: path,
      clientKey: key,
    }),
  );
}

interface RecordRow {
  state: string;
  attempts: number;
  fencing_token: string;
  body: string | null;
}

async function recordRows(path: string, key: string): Promise<RecordRow[]> {
  const result = await observer.query<RecordRow>(
    `SELECT state, attempts, fencing_token::text AS fencing_token,
            convert_from(response_body, 'UTF8') AS body
     FROM ${records} WHERE lookup_key = $1`,
    [await lookup(path, key)],
  );
  return result.rows;
}

/** Polls the store until `sql` (one boolean column, $1 = lookup key) is true. */
async function untilStore(
  sql: string,
  lookupBytes: Buffer,
  what: string,
  deadlineMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const result = await observer.query<{ ok: boolean }>(sql, [lookupBytes]);
    if (result.rows[0]?.ok === true) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} did not happen within ${deadlineMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const leaseExpired = (lookupBytes: Buffer) =>
  untilStore(
    `SELECT clock_timestamp() > lease_expires_at AS ok FROM ${records}
     WHERE lookup_key = $1`,
    lookupBytes,
    "lease expiry on the store's clock",
  );

/** Resolves once `predicate` holds, polling the in-process state with a deadline. */
async function until(
  predicate: () => boolean,
  what: string,
  deadlineMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`${what} did not happen within ${deadlineMs} ms`);
    }
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

/** The real Postgres store, with every renew call counted (timestamps on this process). */
function countingStore(inner: PostgresStore) {
  const renewAt: number[] = [];
  const store: TransactionalStore = {
    lockTimeoutMs: inner.lockTimeoutMs,
    ready: () => inner.ready(),
    begin: (...args) => inner.begin(...args),
    renew: (...args) => {
      renewAt.push(performance.now());
      return inner.renew(...args);
    },
    complete: (...args) => inner.complete(...args),
    release: (...args) => inner.release(...args),
    purgeExpired: (...args) => inner.purgeExpired(...args),
    openTransaction: () => inner.openTransaction(),
  };
  return { store, renewAt };
}

const fencedLogs = (since: number) =>
  logs.slice(since).filter((entry) => entry.fields.outcome === "fenced");

describe("a stalled holder (SIGSTOP) after takeover", () => {
  let child: ChildServer | undefined;

  afterAll(async () => {
    await child?.kill();
  });

  it("is fenced on its next heartbeat: ctx.signal aborts, its complete is fenced and both are logged; the takeover's response is the only record", async () => {
    const path = freshPath();
    child = await startChildServer({
      databaseUrl: url,
      schema,
      secret: SECRET,
      route: path,
      lease: "1s",
    });
    // The takeover runs here, on the same path, route template, key and body.
    mount(
      idemfence({ lease: "1s" }),
      async () => Response.json({ from: "takeover" }, { status: 201 }),
      {},
      path,
    );
    const key = freshKey();
    const lookupBytes = await lookup(path, key);

    const childReply = post(`${child.url}${path}`, key);
    await child.waitFor((event) => event.event === "running");
    const before = await recordRows(path, key);
    expect(before).toHaveLength(1);
    const firstToken = BigInt(before[0]?.fencing_token ?? "0");

    child.stop();
    await leaseExpired(lookupBytes);

    const takeover = await post(path, key);
    expect(takeover.status).toBe(201);
    expect(JSON.parse(takeover.body)).toEqual({ from: "takeover" });
    const after = await recordRows(path, key);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ state: "completed", attempts: 2 });
    expect(BigInt(after[0]?.fencing_token ?? "0")).toBeGreaterThan(firstToken);

    child.resume();
    const aborted = await child.waitFor((event) => event.event === "aborted");
    expect(aborted).toMatchObject({
      name: "IdemfenceFencedError",
      code: "FENCED",
    });
    // The child's own client gets its response, unstored.
    const reply = await childReply;
    expect(reply.status).toBe(201);
    expect(JSON.parse(reply.body)).toEqual({ from: "child" });
    expect(reply.headers.get("idempotent-replayed")).toBeNull();

    const renewalFenced = await child.waitFor(
      (event) =>
        event.event === "log" &&
        String(event.message).includes("lease renewal was fenced"),
    );
    const completeFenced = await child.waitFor(
      (event) =>
        event.event === "log" &&
        String(event.message).includes("complete was fenced"),
    );
    for (const entry of [renewalFenced, completeFenced]) {
      expect(entry).toMatchObject({
        level: "warn",
        fields: expect.objectContaining({ row: 9, outcome: "fenced" }),
      });
    }

    // Exactly one record, holding the takeover's response; a retry replays it.
    const final = await recordRows(path, key);
    expect(final).toHaveLength(1);
    expect(JSON.parse(final[0]?.body ?? "null")).toEqual({ from: "takeover" });
    const retry = await post(path, key);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(JSON.parse(retry.body)).toEqual({ from: "takeover" });
  }, 30_000);
});

describe("the heartbeat", () => {
  it("keeps a handler running about 3 × lease alive: never taken over, and a duplicate gets 409 throughout", async () => {
    const gate = deferred();
    const started = deferred();
    let calls = 0;
    const path = mount(idemfence({ lease: "600ms" }), async () => {
      calls += 1;
      started.resolve();
      await gate.promise;
      return Response.json({ ok: true }, { status: 201 });
    });
    const key = freshKey();
    const lookupBytes = await lookup(path, key);
    const first = post(path, key);
    await started.promise;

    // Until the store's clock says the record has existed for 3 leases.
    const duplicates: number[] = [];
    const deadline = Date.now() + 15_000;
    for (;;) {
      const duplicate = await post(path, key);
      duplicates.push(duplicate.status);
      const live = await observer.query<{ held: boolean; live: boolean }>(
        `SELECT clock_timestamp() - created_at >= interval '1800 milliseconds' AS held,
                lease_expires_at > clock_timestamp() AS live
         FROM ${records} WHERE lookup_key = $1`,
        [lookupBytes],
      );
      expect(live.rows[0]?.live).toBe(true);
      if (live.rows[0]?.held === true) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("3 × lease did not pass within 15 s");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(duplicates.length).toBeGreaterThan(1);
    expect(new Set(duplicates)).toEqual(new Set([409]));

    gate.resolve();
    expect((await first).status).toBe(201);
    expect(calls).toBe(1);
    expect((await recordRows(path, key))[0]).toMatchObject({
      state: "completed",
      attempts: 1,
    });
  }, 30_000);

  for (const [name, settle] of [
    ["resolves", "resolve"],
    ["throws", "throw"],
    ["returns a release status", "release"],
  ] as const) {
    it(`stops when the handler ${name}: no renewal after the response`, async () => {
      const { store, renewAt } = countingStore(postgresStore({ pool, schema }));
      const path = mount(idemfence({ store, lease: "150ms" }), async () => {
        // Run until the heartbeat has renewed a few times.
        await until(() => renewAt.length >= 3, "three renewals");
        if (settle === "throw") {
          throw new Error("after renewals");
        }
        return settle === "release"
          ? new Response("later", { status: 429 })
          : Response.json({ ok: true }, { status: 201 });
      });
      const reply = await post(path, freshKey());
      expect(reply.status).toBe(
        settle === "throw" ? 500 : settle === "release" ? 429 : 201,
      );
      const atResponse = renewAt.length;
      const respondedAt = performance.now();
      // Three heartbeat intervals with nothing to renew: a timer that outlived the request
      // would have fired by now.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(renewAt.length).toBe(atResponse);
      expect(renewAt.every((at) => at < respondedAt)).toBe(true);
    });
  }

  it("never reports a spurious fenced on complete: many handlers whose durations straddle lease / 3", async () => {
    const mark = logs.length;
    const path = mount(idemfence({ lease: "300ms" }), async (request) => {
      const { ms } = (await request.json()) as { ms: number };
      await new Promise((resolve) => setTimeout(resolve, ms));
      return Response.json({ ms }, { status: 201 });
    });
    // 0 to 260 ms in 10 ms steps, around the 100 ms interval, twice, in parallel.
    const durations = Array.from({ length: 54 }, (_, i) => (i % 27) * 10);
    const replies = await Promise.all(
      durations.map(async (ms) => {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-principal": "user-1",
            "idempotency-key": `"${freshKey()}"`,
          },
          body: JSON.stringify({ ms }),
        });
        await response.text();
        return response.status;
      }),
    );
    expect(new Set(replies)).toEqual(new Set([201]));
    expect(fencedLogs(mark)).toEqual([]);
    expect(
      logs
        .slice(mark)
        .filter((entry) => entry.fields.outcome === "renew-failed"),
    ).toEqual([]);
  }, 30_000);
});

describe("heartbeat: false", () => {
  it("lets a handler outlive its lease and be taken over; a later manual renew() aborts ctx.signal, then rejects fenced", async () => {
    const gate = deferred();
    const started = deferred();
    const order: string[] = [];
    let signal: AbortSignal | undefined;
    let renewError: unknown;
    let attempts = 0;
    const idem = idemfence({ lease: "300ms" });
    const path = mount(
      idem,
      async (_request, ctx) => {
        attempts += 1;
        if (attempts > 1) {
          return Response.json({ by: "takeover" }, { status: 201 });
        }
        signal = ctx.signal;
        ctx.signal.addEventListener("abort", () => order.push("aborted"));
        started.resolve();
        await gate.promise;
        try {
          await ctx.renew?.();
        } catch (error) {
          order.push("rejected");
          renewError = error;
        }
        return Response.json({ by: "stalled" }, { status: 201 });
      },
      { heartbeat: false },
    );
    const key = freshKey();
    const first = post(path, key);
    await started.promise;
    await leaseExpired(await lookup(path, key));

    const takeover = await post(path, key);
    expect(JSON.parse(takeover.body)).toEqual({ by: "takeover" });
    const mark = logs.length;
    gate.resolve();
    const stalled = await first;
    expect(JSON.parse(stalled.body)).toEqual({ by: "stalled" });
    expect(stalled.headers.get("idempotent-replayed")).toBeNull();
    expect(renewError).toBeInstanceOf(IdemfenceFencedError);
    expect(order).toEqual(["aborted", "rejected"]);
    expect(signal?.reason).toBeInstanceOf(IdemfenceFencedError);
    // Its complete is fenced and logged; the takeover's record stands.
    expect(fencedLogs(mark)).toHaveLength(1);
    expect(
      JSON.parse((await recordRows(path, key))[0]?.body ?? "null"),
    ).toEqual({ by: "takeover" });
  }, 20_000);

  it("manual renew() keeps a handler alive with the heartbeat off", async () => {
    const { store, renewAt } = countingStore(postgresStore({ pool, schema }));
    const gate = deferred();
    const path = mount(
      idemfence({ store, lease: "300ms" }),
      async (_request, ctx) => {
        await ctx.renew?.();
        await gate.promise;
        return Response.json({ ok: true }, { status: 201 });
      },
      { heartbeat: false },
    );
    const reply = post(path, freshKey());
    await until(() => renewAt.length === 1, "the manual renewal");
    gate.resolve();
    expect((await reply).status).toBe(201);
    // Only the manual call: no heartbeat ran.
    expect(renewAt).toHaveLength(1);
  });
});

describe("maxHold", () => {
  it("aborts ctx.signal with the hold limit, stops renewing and refuses renew(); the lease then expires and a retry takes over", async () => {
    const started = deferred();
    const gate = deferred();
    let reason: unknown;
    let renewError: unknown;
    let attempts = 0;
    const mark = logs.length;
    const path = mount(
      idemfence({ lease: "300ms", maxHold: "700ms" }),
      async (_request, ctx) => {
        attempts += 1;
        if (attempts > 1) {
          return Response.json({ by: "retry" }, { status: 201 });
        }
        started.resolve();
        await new Promise((resolve) => {
          ctx.signal.addEventListener("abort", resolve, { once: true });
        });
        reason = ctx.signal.reason;
        try {
          await ctx.renew?.();
        } catch (error) {
          renewError = error;
        }
        await gate.promise;
        return Response.json({ by: "held" }, { status: 201 });
      },
    );
    const key = freshKey();
    const first = post(path, key);
    await started.promise;
    await until(() => reason !== undefined, "the hold-limit abort");
    expect(reason).toBeInstanceOf(IdemfenceHoldLimitError);
    expect(reason).toMatchObject({ code: "HOLD_LIMIT" });
    await until(() => renewError !== undefined, "the refused renew");
    expect(renewError).toBeInstanceOf(IdemfenceHoldLimitError);
    expect(logs.slice(mark)).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({ row: 9, outcome: "hold-limit" }),
      }),
    ]);

    // No more renewals: the lease expires on the store's clock and a retry takes over.
    await leaseExpired(await lookup(path, key));
    const retry = await post(path, key);
    expect(retry.status).toBe(201);
    expect(JSON.parse(retry.body)).toEqual({ by: "retry" });
    expect((await recordRows(path, key))[0]).toMatchObject({ attempts: 2 });
    gate.resolve();
    await first;
  }, 20_000);
});

describe("configuration", () => {
  const store = {
    begin: async () => undefined as never,
    renew: async () => undefined as never,
    complete: async () => undefined as never,
    release: async () => undefined as never,
  } as unknown as TransactionalStore;
  const required = {
    store,
    scope: () => "p",
    secret: SECRET,
    docsUrl: DOCS,
  };

  it("maxHold defaults to min(10 × lease, retention)", () => {
    expect(resolveConfig(required).maxHold).toBe(300_000);
    expect(resolveConfig({ ...required, lease: "1s" }).maxHold).toBe(10_000);
    expect(
      resolveConfig({ ...required, lease: "500ms", retention: "1500ms" })
        .maxHold,
    ).toBe(1_500);
    expect(resolveConfig({ ...required, maxHold: "2m" }).maxHold).toBe(120_000);
  });

  it("rejects maxHold that is not a duration, not longer than lease, or longer than retention", () => {
    for (const [maxHold, code] of [
      ["soon", "DURATION_INVALID"],
      [0, "DURATION_INVALID"],
      ["30s", "MAX_HOLD_NOT_LONGER_THAN_LEASE"],
      ["10s", "MAX_HOLD_NOT_LONGER_THAN_LEASE"],
      ["25h", "MAX_HOLD_LONGER_THAN_RETENTION"],
    ] as const) {
      expect(() =>
        resolveConfig({ ...required, maxHold } as typeof required),
      ).toThrow(
        expect.objectContaining({ name: "IdemfenceConfigError", code }),
      );
    }
    // Equal to retention is allowed.
    expect(resolveConfig({ ...required, maxHold: "24h" }).maxHold).toBe(
      86_400_000,
    );
  });

  it("heartbeat defaults to true and must be a boolean (ROUTE_FLAG_INVALID)", () => {
    const config = resolveConfig(required);
    expect(resolveRoute(config, { routeTemplate: "/a" }).heartbeat).toBe(true);
    expect(
      resolveRoute(config, { routeTemplate: "/a", heartbeat: false }).heartbeat,
    ).toBe(false);
    for (const heartbeat of ["yes", 1, "false"]) {
      expect(() =>
        resolveRoute(config, {
          routeTemplate: "/a",
          heartbeat,
        } as unknown as { routeTemplate: string }),
      ).toThrow(expect.objectContaining({ code: "ROUTE_FLAG_INVALID" }));
    }
  });
});

describe("ctx.signal where no lease is held", () => {
  /** Mounts a handler that keeps its context's signal and returns 201. */
  function keeping(
    idem: Idemfence,
    route: Partial<FetchRouteConfig>,
  ): { path: string; seen: { signal?: AbortSignal; isRequest?: boolean } } {
    const seen: { signal?: AbortSignal; isRequest?: boolean } = {};
    const path = mount(
      idem,
      async (request, ctx) => {
        seen.signal = ctx.signal;
        seen.isRequest = ctx.signal === request.signal;
        return Response.json({ ok: true }, { status: 201 });
      },
      route,
    );
    return { path, seen };
  }

  async function deadPool(): Promise<pg.Pool> {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() =>
          resolve(
            typeof address === "object" && address !== null ? address.port : 1,
          ),
        );
      });
    });
    return newPool({
      host: "127.0.0.1",
      port,
      database: "none",
      user: "none",
      password: "none",
      connectionString: undefined,
      connectionTimeoutMillis: 500,
    });
  }

  it("transactional, fail-open, keyless and passthrough contexts have a signal that never aborts", async () => {
    const idem = idemfence({ lease: "300ms" });
    const cases = {
      transactional: keeping(idem, { mode: "transactional" }),
      failOpen: keeping(
        idemfence({
          store: postgresStore({ pool: await deadPool(), schema }),
          lease: "300ms",
        }),
        { failOpen: true },
      ),
      keylessLease: keeping(idem, { required: false }),
      keylessTransactional: keeping(idem, {
        required: false,
        mode: "transactional",
      }),
      passthrough: keeping(idem, {}),
    };
    expect((await post(cases.transactional.path, freshKey())).status).toBe(201);
    expect((await post(cases.failOpen.path, freshKey())).status).toBe(201);
    expect((await post(cases.keylessLease.path, undefined)).status).toBe(201);
    expect(
      (await post(cases.keylessTransactional.path, undefined)).status,
    ).toBe(201);
    expect(
      (await post(cases.passthrough.path, freshKey(), { method: "GET" }))
        .status,
    ).toBe(201);
    // Well past a lease and maxHold-sized interval of the lease-mode routes.
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (const [name, { seen }] of Object.entries(cases)) {
      expect(seen.signal, name).toBeInstanceOf(AbortSignal);
      expect(seen.signal?.aborted, name).toBe(false);
      expect(seen.isRequest, name).toBe(false);
    }
  });

  it("lease mode: a client disconnect does not abort ctx.signal (row 16), and the stored response replays", async () => {
    const started = deferred();
    let ctxSignal: AbortSignal | undefined;
    let requestSignal: AbortSignal | undefined;
    let abortedAtReturn: boolean | undefined;
    const path = mount(idemfence({ lease: "300ms" }), async (request, ctx) => {
      ctxSignal = ctx.signal;
      requestSignal = request.signal;
      started.resolve();
      // Until the server has seen the client go away.
      await until(() => request.signal.aborted, "the request's abort");
      abortedAtReturn = ctx.signal.aborted;
      return Response.json({ after: "disconnect" }, { status: 201 });
    });
    const key = freshKey();
    const client = new AbortController();
    const first = post(path, key, { signal: client.signal }).catch(
      (error: unknown) => error,
    );
    await started.promise;
    client.abort();
    expect(await first).toBeInstanceOf(Error);
    await until(() => abortedAtReturn !== undefined, "the handler's return");
    expect(requestSignal?.aborted).toBe(true);
    expect(abortedAtReturn).toBe(false);
    expect(ctxSignal?.aborted).toBe(false);
    await untilStore(
      `SELECT state = 'completed' AS ok FROM ${records} WHERE lookup_key = $1`,
      await lookup(path, key),
      "the record's completion",
    );
    const retry = await post(path, key);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(JSON.parse(retry.body)).toEqual({ after: "disconnect" });
  }, 20_000);
});
