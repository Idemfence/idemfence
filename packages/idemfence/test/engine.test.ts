import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type IdemfenceOptions,
  type LogFields,
  type Logger,
  type RouteConfig,
  resolveConfig,
} from "../src/config.js";
import {
  createEngine,
  type Engine,
  IdemfenceFencedError,
} from "../src/engine.js";
import { lookupKey } from "../src/hash.js";
import {
  postgresStore,
  type SqlExecutor,
  type TransactionalStore,
  withTransaction,
} from "../src/stores/postgres/index.js";
import { connectionFields, databaseUrl, migrate } from "./support/postgres.js";

const url = databaseUrl();
const schema = `idemfence_engine_${randomBytes(4).toString("hex")}`;
const records = `"${schema}".idemfence_records`;
const SECRET = "engine-test-secret-0123456789-abcdefghij";
const DOCS = "https://example.com/docs/idempotency";
const ROUTE: RouteConfig = { routeTemplate: "/orders" };

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
const logsSince = (mark: number) => logs.slice(mark);

let pool: pg.Pool;
let engine: Engine;
let shortLease: Engine;

function makeEngine(
  overrides: Partial<IdemfenceOptions<Request>> = {},
): Engine {
  return createEngine(
    resolveConfig<Request>({
      store: postgresStore({ pool, schema }),
      scope: (request) => request.headers.get("x-principal") ?? undefined,
      secret: SECRET,
      docsUrl: DOCS,
      logger,
      ...overrides,
    }),
  );
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: url, max: 10 });
  await migrate(url, schema);
  await pool.query(`CREATE TABLE "${schema}".orders (id text PRIMARY KEY)`);
  engine = makeEngine();
  shortLease = makeEngine({ lease: "300ms" });
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});

let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `k-${process.pid}-${keyCounter}-${randomBytes(3).toString("hex")}`;
}

interface RequestInit {
  body?: string;
  method?: string;
  principal?: string | null;
  headers?: Record<string, string>;
  url?: string;
  rawKey?: string;
}

function req(key: string | undefined, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (init.rawKey !== undefined) {
    headers.set("idempotency-key", init.rawKey);
  } else if (key !== undefined) {
    headers.set("idempotency-key", `"${key}"`);
  }
  if (init.principal !== null) {
    headers.set("x-principal", init.principal ?? "user-1");
  }
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(init.url ?? "https://api.example.com/orders", {
    method: init.method ?? "POST",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

async function record(key: string, principal = "user-1", template = "/orders") {
  const lk = await lookupKey({
    namespace: "idemfence",
    principal,
    method: "POST",
    routeTemplate: template,
    clientKey: key,
  });
  const result = await pool.query(
    `SELECT state, attempts, response_status, response_headers, body_omitted,
            convert_from(response_body, 'UTF8') AS body
     FROM ${records} WHERE lookup_key = $1`,
    [Buffer.from(lk)],
  );
  return result.rows[0];
}

async function recordCount(): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS n FROM ${records}`);
  return result.rows[0].n;
}

function counting(
  respond: (request: Request) => Response | Promise<Response> = () => created(),
) {
  const calls: Request[] = [];
  const handler = async (request: Request) => {
    calls.push(request);
    return respond(request);
  };
  return { handler, calls };
}

function created(
  body = '{"id":42}',
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    status: 201,
    headers: {
      "content-type": "application/json",
      location: "/orders/42",
      "x-trace": "trace-1",
      ...extraHeaders,
    },
  });
}

async function expectProblem(
  response: Response,
  status: number,
  kind: string,
): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  const body = (await response.json()) as Record<string, unknown>;
  if (kind === "about:blank") {
    expect(body.type).toBe("about:blank");
    expect(response.headers.get("link")).toBeNull();
  } else {
    expect(body.type).toBe(`${DOCS}#${kind}`);
    expect(response.headers.get("link")).toBe(
      `<${DOCS}#${kind}>; rel="describedby"`,
    );
  }
  expect(body.status).toBe(status);
  return body;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("rows 1 to 4: before the store", () => {
  it("row 1: an optional-key route without a key passes through untouched", async () => {
    const route: RouteConfig = { routeTemplate: "/optional", required: false };
    const { handler, calls } = counting(() => created('{"plain":true}'));
    const before = await recordCount();

    const response = await engine.handle(
      req(undefined, { body: "{}" }),
      route,
      handler,
    );

    expect(calls).toHaveLength(1);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"plain":true}');
    expect(response.headers.get("idempotent-replayed")).toBeNull();
    expect(await recordCount()).toBe(before);
  });

  it("row 2: a required key that is missing is a 400 key-missing", async () => {
    const { handler, calls } = counting();
    const before = await recordCount();
    const response = await engine.handle(
      req(undefined, { body: "{}" }),
      ROUTE,
      handler,
    );
    await expectProblem(response, 400, "key-missing");
    expect(calls).toHaveLength(0);
    expect(await recordCount()).toBe(before);
  });

  it("row 3: a malformed key is a 400 key-malformed", async () => {
    const { handler, calls } = counting();
    for (const rawKey of ["unquoted", '"a\tb"', `"${"x".repeat(256)}"`]) {
      const response = await engine.handle(
        req(undefined, { rawKey, body: "{}" }),
        ROUTE,
        handler,
      );
      await expectProblem(response, 400, "key-malformed");
    }
    expect(calls).toHaveLength(0);
  });

  it("row 4: a missing or empty principal is a 500 configuration-error, logged", async () => {
    const { handler, calls } = counting();
    const before = await recordCount();
    for (const principal of [null, ""]) {
      const mark = logs.length;
      const response = await engine.handle(
        req(freshKey(), { body: "{}", principal }),
        ROUTE,
        handler,
      );
      await expectProblem(response, 500, "configuration-error");
      expect(logsSince(mark)).toEqual([
        expect.objectContaining({
          level: "error",
          fields: { row: 4, outcome: "configuration-error" },
        }),
      ]);
    }
    expect(calls).toHaveLength(0);
    expect(await recordCount()).toBe(before);
  });
  it("row 4: a scope that throws or returns a non-string fails closed", async () => {
    const throwing = makeEngine({
      scope: () => {
        throw new Error("auth context missing");
      },
    });
    const nonString = makeEngine({ scope: () => 42 as unknown as string });
    const { handler, calls } = counting();
    const before = await recordCount();

    let mark = logs.length;
    await expectProblem(
      await throwing.handle(req(freshKey(), { body: "{}" }), ROUTE, handler),
      500,
      "configuration-error",
    );
    expect(logsSince(mark)).toEqual([
      expect.objectContaining({
        level: "error",
        fields: {
          row: 4,
          outcome: "configuration-error",
          error: { name: "Error" },
        },
      }),
    ]);

    mark = logs.length;
    await expectProblem(
      await nonString.handle(req(freshKey(), { body: "{}" }), ROUTE, handler),
      500,
      "configuration-error",
    );
    expect(logsSince(mark)).toEqual([
      expect.objectContaining({
        fields: { row: 4, outcome: "configuration-error" },
      }),
    ]);
    expect(calls).toHaveLength(0);
    expect(await recordCount()).toBe(before);
  });
});

describe("rows 5 to 10: record state", () => {
  it("row 5: the first request runs the handler and stores the response", async () => {
    const key = freshKey();
    const { handler, calls } = counting(() =>
      created('{"id":42}', {
        "server-timing": "db;dur=3",
        connection: "close, x-dropme",
        "x-dropme": "1",
      }),
    );

    const response = await engine.handle(
      req(key, { body: '{"amount":1}' }),
      ROUTE,
      handler,
    );

    expect(calls).toHaveLength(1);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"id":42}');
    expect(response.headers.get("idempotent-replayed")).toBeNull();
    // The original response keeps every header.
    expect(response.headers.get("server-timing")).toBe("db;dur=3");
    expect(response.headers.get("x-dropme")).toBe("1");

    const stored = await record(key);
    expect(stored).toMatchObject({
      state: "completed",
      attempts: 1,
      response_status: 201,
      body_omitted: false,
      body: '{"id":42}',
    });
    expect(stored.response_headers).toStrictEqual([
      ["content-type", "application/json"],
      ["location", "/orders/42"],
      ["x-trace", "trace-1"],
    ]);
  });

  it("row 6: the same request again replays the stored response without running the handler", async () => {
    const key = freshKey();
    const { handler, calls } = counting(() =>
      created('{"id":42}', { "server-timing": "x" }),
    );
    const first = await engine.handle(
      req(key, { body: '{"amount":1}' }),
      ROUTE,
      handler,
    );
    expect(first.status).toBe(201);

    const replay = await engine.handle(
      req(key, { body: '{"amount":1}' }),
      ROUTE,
      handler,
    );

    expect(calls).toHaveLength(1);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.headers.get("idempotent-body-omitted")).toBeNull();
    expect(replay.headers.get("content-type")).toBe("application/json");
    expect(replay.headers.get("location")).toBe("/orders/42");
    expect(replay.headers.get("x-trace")).toBe("trace-1");
    expect(replay.headers.get("server-timing")).toBeNull();
    expect(replay.headers.get("content-length")).toBe(
      String('{"id":42}'.length),
    );
    expect(await replay.text()).toBe('{"id":42}');
  });

  it("row 7: the same key with a different body is a 422 key-reused", async () => {
    const key = freshKey();
    const { handler, calls } = counting();
    await engine.handle(req(key, { body: '{"amount":1}' }), ROUTE, handler);

    const response = await engine.handle(
      req(key, { body: '{"amount":2}' }),
      ROUTE,
      handler,
    );

    await expectProblem(response, 422, "key-reused");
    expect(calls).toHaveLength(1);
    expect(await record(key)).toMatchObject({
      state: "completed",
      response_status: 201,
    });
  });

  it("row 8: a request while the first is in flight is a 409 with Retry-After", async () => {
    const key = freshKey();
    const started = deferred<void>();
    const release = deferred<void>();
    const handler = async () => {
      started.resolve();
      await release.promise;
      return created();
    };
    const inFlight = engine.handle(req(key, { body: "{}" }), ROUTE, handler);
    await started.promise;

    const response = await engine.handle(
      req(key, { body: "{}" }),
      ROUTE,
      handler,
    );
    await expectProblem(response, 409, "in-flight");
    const retryAfter = Number(response.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
    expect(await record(key)).toMatchObject({
      state: "in_flight",
      attempts: 1,
    });

    release.resolve();
    expect((await inFlight).status).toBe(201);
    expect(await record(key)).toMatchObject({ state: "completed" });
  });

  it("row 9: an expired lease is taken over; the stale holder is fenced and its result not stored", async () => {
    const key = freshKey();
    const releaseA = deferred<void>();
    let renewError: unknown;
    const handlerA = async (
      _request: Request,
      ctx: { renew(): Promise<void> },
    ) => {
      await releaseA.promise;
      try {
        await ctx.renew();
      } catch (error) {
        renewError = error;
      }
      return created('{"by":"A"}');
    };
    const attemptA = shortLease.handle(
      req(key, { body: "{}" }),
      ROUTE,
      handlerA,
    );
    await sleep(450);

    const { handler: handlerB, calls } = counting(() => created('{"by":"B"}'));
    const responseB = await shortLease.handle(
      req(key, { body: "{}" }),
      ROUTE,
      handlerB,
    );
    expect(calls).toHaveLength(1);
    expect(await responseB.text()).toBe('{"by":"B"}');
    expect(await record(key)).toMatchObject({
      state: "completed",
      attempts: 2,
      body: '{"by":"B"}',
    });

    const mark = logs.length;
    releaseA.resolve();
    const responseA = await attemptA;
    expect(renewError).toBeInstanceOf(IdemfenceFencedError);
    expect(responseA.status).toBe(201);
    expect(await responseA.text()).toBe('{"by":"A"}');
    expect(responseA.headers.get("idempotent-replayed")).toBeNull();
    expect(logsSince(mark)).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({ row: 9, outcome: "fenced" }),
      }),
    ]);
    expect(await record(key)).toMatchObject({ body: '{"by":"B"}' });

    const replay = await engine.handle(
      req(key, { body: "{}" }),
      ROUTE,
      handlerB,
    );
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.text()).toBe('{"by":"B"}');
  });

  it("row 10: a key past retention is treated as a first request", async () => {
    const key = freshKey();
    let n = 0;
    const { handler, calls } = counting(() => {
      n += 1;
      return created(`{"n":${n}}`);
    });
    await engine.handle(req(key, { body: "{}" }), ROUTE, handler);
    const lk = await lookupKey({
      namespace: "idemfence",
      principal: "user-1",
      method: "POST",
      routeTemplate: "/orders",
      clientKey: key,
    });
    await pool.query(
      `UPDATE ${records} SET expires_at = clock_timestamp() - interval '1 second' WHERE lookup_key = $1`,
      [Buffer.from(lk)],
    );

    const response = await engine.handle(
      req(key, { body: "{}" }),
      ROUTE,
      handler,
    );

    expect(calls).toHaveLength(2);
    expect(response.headers.get("idempotent-replayed")).toBeNull();
    expect(await response.text()).toBe('{"n":2}');
    expect(await record(key)).toMatchObject({
      state: "completed",
      attempts: 1,
      body: '{"n":2}',
    });
  });
});

describe("rows 11 and 12: after the handler", () => {
  it("row 11: a release status is returned as-is and the record deleted", async () => {
    const key = freshKey();
    const { handler, calls } = counting(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "7" },
        }),
    );

    const response = await engine.handle(
      req(key, { body: "{}" }),
      ROUTE,
      handler,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.text()).toBe("slow down");
    expect(await record(key)).toBeUndefined();

    await engine.handle(req(key, { body: "{}" }), ROUTE, handler);
    expect(calls).toHaveLength(2);
  });

  it("row 12: a thrown error becomes a stored 500 about:blank problem that replays", async () => {
    const key = freshKey();
    let calls = 0;
    const handler = async () => {
      calls += 1;
      throw new Error("boom");
    };
    const mark = logs.length;

    const response = await engine.handle(
      req(key, { body: "{}" }),
      ROUTE,
      handler,
    );
    const body = await expectProblem(response, 500, "about:blank");
    expect(body.title).toBe("Internal Server Error");
    expect(body.detail).not.toContain("boom");
    expect(logsSince(mark)).toEqual([
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({
          row: 12,
          outcome: "handler-error",
          error: { name: "Error" },
        }),
      }),
    ]);
    expect(await record(key)).toMatchObject({
      state: "completed",
      response_status: 500,
    });

    const replay = await engine.handle(
      req(key, { body: "{}" }),
      ROUTE,
      handler,
    );
    expect(calls).toBe(1);
    expect(replay.status).toBe(500);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
  });

  it("row 11 vs 12: a throw is stored even when 500 is a release status; a returned 500 is released", async () => {
    const route: RouteConfig = {
      routeTemplate: "/orders",
      releaseStatuses: [500],
    };
    const thrownKey = freshKey();
    let throws = 0;
    const thrower = async () => {
      throws += 1;
      throw new Error("boom");
    };
    expect(
      (await engine.handle(req(thrownKey, { body: "{}" }), route, thrower))
        .status,
    ).toBe(500);
    expect(await record(thrownKey)).toMatchObject({
      state: "completed",
      response_status: 500,
    });
    const replay = await engine.handle(
      req(thrownKey, { body: "{}" }),
      route,
      thrower,
    );
    expect(throws).toBe(1);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");

    const returnedKey = freshKey();
    const { handler, calls } = counting(
      () => new Response("fail", { status: 500 }),
    );
    expect(
      (await engine.handle(req(returnedKey, { body: "{}" }), route, handler))
        .status,
    ).toBe(500);
    expect(await record(returnedKey)).toBeUndefined();
    await engine.handle(req(returnedKey, { body: "{}" }), route, handler);
    expect(calls).toHaveLength(2);
  });

  it("row 12: a 5xx returned by the handler is stored and replayed", async () => {
    const key = freshKey();
    const { handler, calls } = counting(
      () => new Response("upstream down", { status: 502 }),
    );
    const first = await engine.handle(req(key, { body: "{}" }), ROUTE, handler);
    expect(first.status).toBe(502);
    const replay = await engine.handle(
      req(key, { body: "{}" }),
      ROUTE,
      handler,
    );
    expect(calls).toHaveLength(1);
    expect(replay.status).toBe(502);
    expect(await replay.text()).toBe("upstream down");
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
  });
});

describe("row 15: request body cap", () => {
  it("a body over requestBodyCap is a 413 and the handler does not run", async () => {
    const route: RouteConfig = { routeTemplate: "/small", requestBodyCap: 16 };
    const { handler, calls } = counting();
    const before = await recordCount();
    const response = await engine.handle(
      req(freshKey(), {
        body: "x".repeat(17),
        url: "https://api.example.com/small",
      }),
      route,
      handler,
    );
    await expectProblem(response, 413, "body-too-large");
    expect(calls).toHaveLength(0);
    expect(await recordCount()).toBe(before);
  });
});

describe("row 14: store unavailable", () => {
  let unreachable: Engine;
  let deadPool: pg.Pool;

  beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() =>
          resolve(
            typeof address === "object" && address !== null ? address.port : 1,
          ),
        );
      });
    });
    deadPool = new pg.Pool({
      host: "127.0.0.1",
      port,
      database: "none",
      user: "none",
      password: "none",
      connectionTimeoutMillis: 500,
    });
    deadPool.on("error", () => {});
    unreachable = createEngine(
      resolveConfig<Request>({
        store: postgresStore({ pool: deadPool }),
        scope: (request) => request.headers.get("x-principal") ?? undefined,
        secret: SECRET,
        docsUrl: DOCS,
        logger,
      }),
    );
  });

  afterAll(async () => {
    await deadPool.end();
  });

  it("is a 503 store-unavailable with the default Retry-After, logged", async () => {
    const { handler, calls } = counting();
    const mark = logs.length;
    const response = await unreachable.handle(
      req(freshKey(), { body: "{}" }),
      ROUTE,
      handler,
    );
    await expectProblem(response, 503, "store-unavailable");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(calls).toHaveLength(0);
    expect(logsSince(mark)).toEqual([
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({
          row: 14,
          outcome: "store-unavailable",
        }),
      }),
    ]);
  });

  it("uses the route's storeUnavailableRetryAfter", async () => {
    const route: RouteConfig = {
      routeTemplate: "/orders",
      storeUnavailableRetryAfter: "2s",
    };
    const response = await unreachable.handle(
      req(freshKey(), { body: "{}" }),
      route,
      counting().handler,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
  });

  it("transactional mode: a store that cannot be reached at begin is a 503, handler not run", async () => {
    const { handler, calls } = counting();
    const response = await unreachable.handle(
      req(freshKey(), { body: "{}" }),
      { routeTemplate: "/orders", mode: "transactional" },
      handler,
    );
    await expectProblem(response, 503, "store-unavailable");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(calls).toHaveLength(0);
  });

  it("transactional mode: a transaction that cannot be opened is a 503, not a stored 500, and frees the key", async () => {
    // The record operations reach Postgres; opening the handler's transaction does not.
    const live = postgresStore({ pool, schema });
    const txStore: TransactionalStore = {
      ...live,
      ready: () => live.ready(),
      begin: (...args) => live.begin(...args),
      renew: (...args) => live.renew(...args),
      complete: (...args) => live.complete(...args),
      release: (...args) => live.release(...args),
      purgeExpired: (...args) => live.purgeExpired(...args),
      lockTimeoutMs: live.lockTimeoutMs,
      transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
        withTransaction(deadPool, {}, fn),
    };
    const txUnavailable = createEngine(
      resolveConfig<Request>({
        store: txStore,
        scope: (request) => request.headers.get("x-principal") ?? undefined,
        secret: SECRET,
        docsUrl: DOCS,
        logger,
      }),
    );
    const key = freshKey();
    const route: RouteConfig = {
      routeTemplate: "/orders",
      mode: "transactional",
      storeUnavailableRetryAfter: "3s",
    };
    const { handler, calls } = counting();
    const mark = logs.length;

    const response = await txUnavailable.handle(
      req(key, { body: "{}" }),
      route,
      handler,
    );
    await expectProblem(response, 503, "store-unavailable");
    expect(response.headers.get("retry-after")).toBe("3");
    expect(calls).toHaveLength(0);
    expect(await record(key)).toBeUndefined();
    expect(logsSince(mark)).toEqual([
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({
          row: 14,
          outcome: "store-unavailable",
          error: expect.objectContaining({ name: expect.any(String) }),
        }),
      }),
    ]);

    // The key is free: a retry on a healthy engine runs the handler and completes.
    const retry = await engine.handle(req(key, { body: "{}" }), route, handler);
    expect(retry.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(await record(key)).toMatchObject({ state: "completed" });
  });

  it("transactional mode: a COMMIT failure is a 503 with the handler's writes rolled back and the key free", async () => {
    await pool.query(
      `CREATE TABLE "${schema}".deferred (id int UNIQUE DEFERRABLE INITIALLY DEFERRED)`,
    );
    const key = freshKey();
    const route: RouteConfig = {
      routeTemplate: "/orders",
      mode: "transactional",
    };
    let runs = 0;
    const handler = async (
      _request: Request,
      ctx: {
        tx?: { query(t: string, p?: readonly unknown[]): Promise<unknown> };
      },
    ) => {
      runs += 1;
      // Violates the deferred constraint, so BEGIN and the handler succeed and COMMIT fails.
      await ctx.tx?.query(
        `INSERT INTO "${schema}".deferred (id) VALUES (1), (1)`,
      );
      return created();
    };
    const mark = logs.length;
    const response = await engine.handle(
      req(key, { body: "{}" }),
      route,
      handler,
    );
    await expectProblem(response, 503, "store-unavailable");
    expect(runs).toBe(1);
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM "${schema}".deferred`))
        .rows[0].n,
    ).toBe(0);
    expect(await record(key)).toBeUndefined();
    expect(logsSince(mark)).toEqual([
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({
          row: 14,
          outcome: "store-unavailable",
        }),
      }),
    ]);
  });

  it("transactional mode: a connection failure during COMMIT is a 503 that keeps the lease (outcome unknown)", async () => {
    const key = freshKey();
    const route: RouteConfig = {
      routeTemplate: "/orders",
      mode: "transactional",
      storeUnavailableRetryAfter: "4s",
    };
    const observer = new pg.Client({ connectionString: url });
    await observer.connect();
    const mark = logs.length;
    try {
      const response = await engine.handle(
        req(key, { body: "{}" }),
        route,
        async (_request, ctx) => {
          const pid = (
            await ctx.tx?.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            )
          )?.rows[0]?.pid;
          await observer.query("SELECT pg_terminate_backend($1)", [pid]);
          await sleep(50);
          return created();
        },
      );
      await expectProblem(response, 503, "store-unavailable");
      expect(response.headers.get("retry-after")).toBe("4");
    } finally {
      await observer.end();
    }
    // The commit may have landed, so the lease is kept: the key is not free until 2.2 moves
    // the record into the transaction or the lease expires.
    expect(await record(key)).toMatchObject({ state: "in_flight" });
    expect(logsSince(mark)).toEqual([
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({
          row: 14,
          outcome: "commit-unknown",
          error: expect.objectContaining({ code: "COMMIT_UNKNOWN" }),
        }),
      }),
    ]);
  });

  it("with failOpen, runs the handler without idempotency and logs a warning", async () => {
    const route: RouteConfig = { routeTemplate: "/orders", failOpen: true };
    const { handler, calls } = counting(() => created('{"open":true}'));
    const mark = logs.length;
    const response = await unreachable.handle(
      req(freshKey(), { body: "{}" }),
      route,
      handler,
    );
    expect(calls).toHaveLength(1);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"open":true}');
    expect(logsSince(mark)).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({ row: 14, outcome: "fail-open" }),
      }),
    ]);
  });
});

describe("complete() failures (contract section 5)", () => {
  const role = `${schema}_writer`;
  let restrictedPool: pg.Pool;
  let restricted: Engine;

  beforeAll(async () => {
    await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'writer'`);
    await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await pool.query(
      `GRANT ALL ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`,
    );
    await pool.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`,
    );
    restrictedPool = new pg.Pool({
      ...connectionFields(url),
      user: role,
      password: "writer",
      max: 1,
    });
    restrictedPool.on("error", () => {});
    restricted = createEngine(
      resolveConfig<Request>({
        store: postgresStore({ pool: restrictedPool, schema }),
        scope: (request) => request.headers.get("x-principal") ?? undefined,
        secret: SECRET,
        docsUrl: DOCS,
        logger,
      }),
    );
  });

  afterAll(async () => {
    await restrictedPool.end();
    await pool.query(
      `REVOKE ALL ON ALL TABLES IN SCHEMA "${schema}" FROM "${role}"`,
    );
    await pool.query(
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA "${schema}" FROM "${role}"`,
    );
    await pool.query(`REVOKE USAGE ON SCHEMA "${schema}" FROM "${role}"`);
    await pool.query(`DROP ROLE "${role}"`);
  });

  it("retries complete three times, then sends the handler's response and logs an error", async () => {
    const key = freshKey();
    const handler = async () => {
      // The store loses the right to write between begin and complete.
      await pool.query(`REVOKE UPDATE ON ${records} FROM "${role}"`);
      return created('{"unstored":true}');
    };
    const mark = logs.length;
    const startedAt = Date.now();
    try {
      const response = await restricted.handle(
        req(key, { body: "{}" }),
        ROUTE,
        handler,
      );
      expect(response.status).toBe(201);
      expect(await response.text()).toBe('{"unstored":true}');
      expect(response.headers.get("idempotent-replayed")).toBeNull();
    } finally {
      await pool.query(`GRANT UPDATE ON ${records} TO "${role}"`);
    }
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    const entries = logsSince(mark);
    expect(
      entries.map((e) => [e.level, e.fields.outcome, e.fields.attempt]),
    ).toStrictEqual([
      ["warn", "complete-retry", 1],
      ["warn", "complete-retry", 2],
      ["error", "store_error", 3],
    ]);
    expect(entries[2]?.fields.error).toStrictEqual({
      name: "error",
      code: "42501",
    });
    expect(await record(key)).toMatchObject({
      state: "in_flight",
      response_status: null,
    });
  });

  it("recovers when the backend connection is terminated between begin and complete", async () => {
    const key = freshKey();
    const handler = async () => {
      const pid = (await restrictedPool.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      await pool.query("SELECT pg_terminate_backend($1)", [pid]);
      await sleep(50);
      return created('{"recovered":true}');
    };
    const mark = logs.length;
    const response = await restricted.handle(
      req(key, { body: "{}" }),
      ROUTE,
      handler,
    );
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"recovered":true}');
    expect(logsSince(mark).filter((e) => e.level === "error")).toHaveLength(0);
    expect(await record(key)).toMatchObject({
      state: "completed",
      body: '{"recovered":true}',
    });
  });
});

describe("response capture (contract section 5)", () => {
  it("over-cap response: the client gets every byte; the replay has no body", async () => {
    const route: RouteConfig = { routeTemplate: "/big", responseBodyCap: 1024 };
    const key = freshKey();
    const chunk = new Uint8Array(1000).fill(0x61);
    const handler = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < 5; i += 1) {
              controller.enqueue(chunk.slice());
            }
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/plain", etag: '"v1"' },
        },
      );
    const mark = logs.length;

    const response = await engine.handle(
      req(key, { body: "{}", url: "https://api.example.com/big" }),
      route,
      handler,
    );
    expect(response.status).toBe(200);
    const received = new Uint8Array(await response.arrayBuffer());
    expect(received).toHaveLength(5000);
    expect(received.every((byte) => byte === 0x61)).toBe(true);
    expect(logsSince(mark)).toEqual([
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({ outcome: "body-omitted" }),
      }),
    ]);
    expect(await record(key, "user-1", "/big")).toMatchObject({
      state: "completed",
      body_omitted: true,
      body: null,
    });

    const replay = await engine.handle(
      req(key, { body: "{}", url: "https://api.example.com/big" }),
      route,
      handler,
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.headers.get("idempotent-body-omitted")).toBe("true");
    expect(replay.headers.get("etag")).toBe('"v1"');
    expect(replay.headers.get("content-length")).toBe("0");
    expect(await replay.text()).toBe("");
  });

  it("Set-Cookie is sent to the original client but not replayed, unless the route allows it", async () => {
    const respond = () =>
      created('{"ok":true}', { "set-cookie": "session=abc; HttpOnly" });
    const key = freshKey();
    const original = await engine.handle(
      req(key, { body: "{}" }),
      ROUTE,
      counting(respond).handler,
    );
    expect(original.headers.getSetCookie()).toStrictEqual([
      "session=abc; HttpOnly",
    ]);
    const replay = await engine.handle(
      req(key, { body: "{}" }),
      ROUTE,
      counting(respond).handler,
    );
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.headers.getSetCookie()).toStrictEqual([]);

    const route: RouteConfig = {
      routeTemplate: "/sessions",
      allowSetCookieReplay: true,
    };
    const key2 = freshKey();
    const url2 = "https://api.example.com/sessions";
    await engine.handle(
      req(key2, { body: "{}", url: url2 }),
      route,
      counting(respond).handler,
    );
    const replay2 = await engine.handle(
      req(key2, { body: "{}", url: url2 }),
      route,
      counting(respond).handler,
    );
    expect(replay2.headers.get("idempotent-replayed")).toBe("true");
    expect(replay2.headers.getSetCookie()).toStrictEqual([
      "session=abc; HttpOnly",
    ]);
  });

  it("a text/event-stream response is rejected as a stored 500", async () => {
    const key = freshKey();
    const handler = async () =>
      new Response("data: hi\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const mark = logs.length;
    const response = await engine.handle(
      req(key, { body: "{}" }),
      ROUTE,
      handler,
    );
    const body = await expectProblem(response, 500, "about:blank");
    expect(body.detail).toContain("Streaming responses are not supported");
    expect(logsSince(mark)).toEqual([
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({ outcome: "streaming-rejected" }),
      }),
    ]);
    expect(await record(key)).toMatchObject({
      state: "completed",
      response_status: 500,
    });
  });

  it("a stored 204 replays with a null body", async () => {
    const key = freshKey();
    const handler = async () =>
      new Response(null, { status: 204, headers: { "x-trace": "t" } });
    await engine.handle(req(key, { body: "{}" }), ROUTE, handler);
    const replay = await engine.handle(
      req(key, { body: "{}" }),
      ROUTE,
      handler,
    );
    expect(replay.status).toBe(204);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.body).toBeNull();
  });
});

describe("logging (contract section 8)", () => {
  it("never logs raw keys, bodies or header values", async () => {
    const KEY = `SENTINEL-KEY-${randomBytes(4).toString("hex")}`;
    const BODY = '{"card":"SENTINEL-BODY-4111"}';
    const HEADER = "SENTINEL-HEADER-token";
    const route: RouteConfig = {
      routeTemplate: "/orders",
      headerAllowlist: ["x-sentinel"],
    };
    const headers = { "x-sentinel": HEADER };
    const mark = logs.length;

    // Row 4, row 12 (throw), row 15, and a stored over-cap body, all with the sentinels.
    await engine.handle(
      req(KEY, { body: BODY, headers, principal: null }),
      route,
      counting().handler,
    );
    await engine.handle(req(KEY, { body: BODY, headers }), route, async () => {
      throw new Error(`failed for ${KEY} with ${BODY} and ${HEADER}`);
    });
    await engine.handle(
      req(`${KEY}-big`, { body: "x".repeat(2_000_000), headers }),
      route,
      counting().handler,
    );
    await engine.handle(
      req(`${KEY}-stream`, { body: BODY, headers }),
      route,
      async () =>
        new Response(`${KEY} ${BODY}`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const entries = logsSince(mark);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain(KEY);
    expect(serialised).not.toContain("SENTINEL-BODY");
    expect(serialised).not.toContain("SENTINEL-HEADER");
    expect(serialised).not.toContain("failed for");
    for (const entry of entries) {
      expect(
        Object.keys(entry.fields).every((k) =>
          ["keyHash", "row", "outcome", "attempt", "error"].includes(k),
        ),
      ).toBe(true);
      if (entry.fields.keyHash !== undefined) {
        expect(entry.fields.keyHash).toMatch(/^[0-9a-f]{8}$/);
      }
    }
  });
});

describe("handler context: tx", () => {
  const TX_ROUTE: RouteConfig = {
    routeTemplate: "/orders",
    mode: "transactional",
  };
  const orderRow = async (id: string) =>
    (await pool.query(`SELECT id FROM "${schema}".orders WHERE id = $1`, [id]))
      .rowCount;

  it("lease mode: ctx.tx is absent", async () => {
    let seen: unknown = "unset";
    const response = await engine.handle(
      req(freshKey(), { body: "{}" }),
      ROUTE,
      async (_request, ctx) => {
        seen = ctx.tx;
        expect("tx" in ctx).toBe(false);
        return created();
      },
    );
    expect(response.status).toBe(201);
    expect(seen).toBeUndefined();
  });

  it("transactional mode: ctx.tx runs inside a transaction that commits with the handler", async () => {
    const key = freshKey();
    const id = `order-${key}`;
    const response = await engine.handle(
      req(key, { body: "{}" }),
      TX_ROUTE,
      async (_request, ctx) => {
        if (ctx.tx === undefined) {
          throw new Error("ctx.tx missing");
        }
        await ctx.tx.query(`INSERT INTO "${schema}".orders (id) VALUES ($1)`, [
          id,
        ]);
        const shown = await ctx.tx.query<{ lock_timeout: string }>(
          "SHOW lock_timeout",
        );
        expect(shown.rows[0]?.lock_timeout).toBe("250ms");
        // Not yet committed: another connection cannot see it.
        expect(await orderRow(id)).toBe(0);
        return created();
      },
    );
    expect(response.status).toBe(201);
    expect(await orderRow(id)).toBe(1);
    expect(await record(key)).toMatchObject({ state: "completed" });
  });

  it("transactional mode: ctx.renew() runs on the transaction, so a saturated pool cannot deadlock", async () => {
    // One connection in the pool, held by the handler's transaction: a renew that went
    // through the pool would wait for it forever.
    const single = new pg.Pool({ connectionString: url, max: 1 });
    single.on("error", () => {});
    try {
      const singleEngine = createEngine(
        resolveConfig<Request>({
          store: postgresStore({ pool: single, schema }),
          scope: (request) => request.headers.get("x-principal") ?? undefined,
          secret: SECRET,
          docsUrl: DOCS,
          logger,
        }),
      );
      const key = freshKey();
      let renewed = "not called";
      const response = await singleEngine.handle(
        req(key, { body: "{}" }),
        TX_ROUTE,
        async (_request, ctx) => {
          renewed = await Promise.race([
            ctx.renew().then(() => "renewed"),
            sleep(2_000).then(() => "timed out"),
          ]);
          return created();
        },
      );
      expect(renewed).toBe("renewed");
      expect(response.status).toBe(201);
      expect(await record(key)).toMatchObject({ state: "completed" });
    } finally {
      await single.end();
    }
  });

  it("transactional mode: a throw rolls the handler's writes back", async () => {
    const key = freshKey();
    const id = `order-${key}`;
    const mark = logs.length;
    let hadTx = false;
    const response = await engine.handle(
      req(key, { body: "{}" }),
      TX_ROUTE,
      async (_request, ctx) => {
        hadTx = ctx.tx !== undefined;
        await ctx.tx?.query(`INSERT INTO "${schema}".orders (id) VALUES ($1)`, [
          id,
        ]);
        throw new Error("after writing");
      },
    );
    expect(response.status).toBe(500);
    expect(hadTx).toBe(true);
    expect(await orderRow(id)).toBe(0);
    expect(logsSince(mark)).toEqual([
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({ row: 12 }),
      }),
    ]);
  });
});

describe("route validation", () => {
  it("rejects an invalid route template and non-boolean flags on first use", async () => {
    for (const [route, code] of [
      [{ routeTemplate: "orders" }, "ROUTE_TEMPLATE_INVALID"],
      [{ routeTemplate: "/orders", mode: "tx" }, "ROUTE_MODE_INVALID"],
      [{ routeTemplate: "" }, "ROUTE_TEMPLATE_INVALID"],
      [{ routeTemplate: "/a b" }, "ROUTE_TEMPLATE_INVALID"],
      [{ routeTemplate: "/orders", failOpen: "yes" }, "ROUTE_FLAG_INVALID"],
      [
        { routeTemplate: "/orders", allowSetCookieReplay: 1 },
        "ROUTE_FLAG_INVALID",
      ],
      [{ routeTemplate: "/orders", keyMaxLength: 0 }, "KEY_MAX_LENGTH_INVALID"],
      [
        { routeTemplate: "/orders", releaseStatuses: [200] },
        "RELEASE_STATUS_INVALID",
      ],
      [
        { routeTemplate: "/orders", storeUnavailableRetryAfter: "soon" },
        "DURATION_INVALID",
      ],
    ] as const) {
      await expect(
        engine.handle(
          req(freshKey(), { body: "{}" }),
          route as RouteConfig,
          counting().handler,
        ),
      ).rejects.toEqual(
        expect.objectContaining({ name: "IdemfenceConfigError", code }),
      );
    }
  });
});
