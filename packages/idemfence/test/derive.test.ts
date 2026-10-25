// Derived downstream keys (docs/contract.md section 5 and Appendix A) end to end: real HTTP
// through the fetch adapter, a real Postgres, no mocked store, framework or clock. Waits
// synchronise on state (a handler gate, the store's clock), never on sleeps.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LogFields, Logger } from "../src/config.js";
import {
  type FetchRouteConfig,
  type Handler,
  idempotent,
} from "../src/fetch.js";
import { derivedKey, deriveHmacKey, lookupKey } from "../src/hash.js";
import {
  createIdemfence,
  type Idemfence,
  type IdemfenceDeriveError,
  type IdemfenceOptions,
} from "../src/index.js";
import { postgresStore } from "../src/stores/postgres/index.js";
import { databaseUrl, migrate } from "./support/postgres.js";

const url = databaseUrl();
const schema = `idemfence_derive_${randomBytes(4).toString("hex")}`;
const records = `"${schema}".idemfence_records`;
const DOCS = "https://example.com/docs/idempotency";

// Appendix A, "Derived downstream keys".
const VECTOR_SECRET = "idemfence-derive-test-vector-secret-0123456789";
const L1 = "20a9b317bd9314b4fe75ed1ca5b16184ee9ef404bd0ba1e92530fcfd6f3a9b61";
const L2 = "9cf6d67825a4d64a64c4d609427cfed8482e4adb8be186740cbda0d6e3122848";
const LONG_LABEL = `!${"x".repeat(126)}~`;
const VECTORS = [
  {
    id: "D1",
    lookup: L1,
    label: "payment-charge",
    key: "c06b117ddfd327dc94cb2db75791895cabee3ee5e6e85a6d290cda873dd5c805",
  },
  {
    id: "D2",
    lookup: L1,
    label: "payment-refund",
    key: "06e2b2369046aa0f4017bcdcbc48cc467c16002e7e72f6b06633e042423f0ed8",
  },
  {
    id: "D3",
    lookup: L1,
    label: LONG_LABEL,
    key: "cdd7f794ac16ccf248d9432ae9caba4232c031d0360250a19f2ab142b0986a3e",
  },
  {
    id: "D4",
    lookup: L2,
    label: "payment-charge",
    key: "306f9287aa19352006b682010b37ccf8a4e74a02da4402aa67d4969d6a09328f",
  },
] as const;

// Three distinct secrets for the rotation tests, each over 32 bytes.
const SECRET_A = "derive-rotation-secret-A-0123456789-abcdef";
const SECRET_B = "derive-rotation-secret-B-0123456789-abcdef";
const SECRET_C = "derive-rotation-secret-C-0123456789-abcdef";

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
/** Every derived key any handler in this file saw, for the log check at the end. */
const derived = new Set<string>();

const pools: pg.Pool[] = [];
let pool: pg.Pool;
let deadPool: pg.Pool;
let server: ServerType;
let base: string;
const routes = new Map<string, (request: Request) => Promise<Response>>();

function newPool(config: pg.PoolConfig = {}): pg.Pool {
  const created = new pg.Pool({ connectionString: url, max: 10, ...config });
  created.on("error", () => {});
  pools.push(created);
  return created;
}

async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
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
}

function idemfence(
  options: Partial<IdemfenceOptions<Request>> = {},
): Idemfence {
  return createIdemfence({
    store: postgresStore({ pool, schema }),
    scope: (request) => request.headers.get("x-principal") ?? undefined,
    secret: VECTOR_SECRET,
    docsUrl: DOCS,
    logger,
    ...options,
  });
}

beforeAll(async () => {
  pool = newPool();
  await migrate(url, schema);
  deadPool = newPool({
    host: "127.0.0.1",
    port: await closedPort(),
    database: "none",
    user: "none",
    password: "none",
    connectionString: undefined,
    connectionTimeoutMillis: 500,
  });
  const app = new Hono();
  app.on(["POST", "PATCH", "GET"], "/r/:name", (c) => {
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
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await Promise.all(pools.map((p) => p.end()));
});

let routeCounter = 0;
/** Mounts `handler` and returns its path; the route template is `route`'s or the path. */
function mount(
  idem: Idemfence,
  handler: Handler,
  route: Partial<FetchRouteConfig> = {},
): string {
  routeCounter += 1;
  const name = `t${routeCounter}`;
  routes.set(
    name,
    idempotent(
      idem,
      { routeTemplate: `/r/${name}`, ...route } as FetchRouteConfig,
      handler,
    ),
  );
  return `/r/${name}`;
}

const freshKey = () => `k-${randomBytes(8).toString("hex")}`;

interface Send {
  key?: string | undefined;
  principal?: string;
  method?: string;
  body?: string;
}

async function send(
  path: string,
  { key, principal = "user-1", method = "POST", body = "{}" }: Send,
): Promise<{ status: number; body: string; headers: Headers }> {
  const headers: Record<string, string> = { "x-principal": principal };
  if (key !== undefined) {
    headers["idempotency-key"] = `"${key}"`;
  }
  if (method !== "GET") {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(method === "GET" ? {} : { body }),
  });
  return {
    status: response.status,
    body: await response.text(),
    headers: response.headers,
  };
}

/** Derives `label`, records the value for the log check, and returns it. */
async function derive(
  ctx: Parameters<Handler>[1],
  label: string,
): Promise<string> {
  const value = await ctx.deriveKey(label);
  derived.add(value);
  return value;
}

/** Settles a deriveKey call to its error code, or "resolved". */
async function outcome(attempt: Promise<string>): Promise<string> {
  try {
    const value = await attempt;
    derived.add(value);
    return "resolved";
  } catch (error) {
    const deriveError = error as IdemfenceDeriveError;
    return deriveError.name === "IdemfenceDeriveError"
      ? deriveError.code
      : `unexpected ${String(error)}`;
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));

describe("contract Appendix A: derived downstream keys", () => {
  it("reproduces D1 to D4 byte for byte", async () => {
    const hmac = await deriveHmacKey(new TextEncoder().encode(VECTOR_SECRET));
    for (const vector of VECTORS) {
      expect(
        await derivedKey(hmac, fromHex(vector.lookup), vector.label),
        vector.id,
      ).toBe(vector.key);
    }
  });

  it("reproduces D1 to D3 through ctx.deriveKey for the L1 request", async () => {
    // L1: principal user-1, POST, route template /orders, client key 8e03978e-....
    const seen: string[] = [];
    const path = mount(
      idemfence(),
      async (_request, ctx) => {
        for (const vector of VECTORS.slice(0, 3)) {
          seen.push(await derive(ctx, vector.label));
        }
        return new Response("later", { status: 429 });
      },
      { routeTemplate: "/orders" },
    );
    expect(
      (await send(path, { key: "8e03978e-40d5-43e8-bc93-6894a57f9324" }))
        .status,
    ).toBe(429);
    expect(seen).toEqual(VECTORS.slice(0, 3).map((vector) => vector.key));
    // And the lookup key really is L1.
    expect(
      Buffer.from(
        await lookupKey({
          namespace: "idemfence",
          principal: "user-1",
          method: "POST",
          routeTemplate: "/orders",
          clientKey: "8e03978e-40d5-43e8-bc93-6894a57f9324",
        }),
      ).toString("hex"),
    ).toBe(L1);
  });
});

describe("every attempt of the same request derives the same key", () => {
  it("(a) lease mode: the attempt that takes over an expired lease (row 9) derives the first attempt's key", async () => {
    const idem = idemfence({ lease: "300ms" });
    const started = deferred();
    const gate = deferred();
    const seen: string[] = [];
    let attempts = 0;
    const path = mount(idem, async (_request, ctx) => {
      attempts += 1;
      seen.push(await derive(ctx, "payment-charge"));
      if (attempts === 1) {
        started.resolve();
        await gate.promise;
      }
      return Response.json({ attempt: attempts }, { status: 201 });
    });
    const key = freshKey();
    const lookup = Buffer.from(
      await lookupKey({
        namespace: "idemfence",
        principal: "user-1",
        method: "POST",
        routeTemplate: path,
        clientKey: key,
      }),
    );

    const first = send(path, { key });
    await started.promise;
    // Wait on the store's clock, not ours: poll until it is past lease_expires_at.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const expired = await pool.query<{ expired: boolean }>(
        `SELECT clock_timestamp() > lease_expires_at AS expired FROM ${records}
         WHERE lookup_key = $1`,
        [lookup],
      );
      if (expired.rows[0]?.expired === true) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(
          "the lease did not expire on the store's clock within 5 s",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const second = await send(path, { key });
    expect(second.status).toBe(201);
    expect(JSON.parse(second.body)).toEqual({ attempt: 2 });
    const stored = await pool.query<{ attempts: number }>(
      `SELECT attempts FROM ${records} WHERE lookup_key = $1`,
      [lookup],
    );
    expect(stored.rows[0]?.attempts).toBe(2);
    gate.resolve();
    expect((await first).status).toBe(201);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });

  for (const [name, firstAttempt] of [
    ["throws (row 13, rolled back)", "throw"],
    ["returns a release status (row 11)", "release"],
  ] as const) {
    it(`(b) transactional mode: a retry after attempt 1 ${name} derives the same key`, async () => {
      const seen: string[] = [];
      const path = mount(
        idemfence(),
        async (_request, ctx) => {
          seen.push(await derive(ctx, "payment-charge"));
          if (seen.length === 1) {
            if (firstAttempt === "throw") {
              throw new Error("after deriving");
            }
            return new Response("later", { status: 429 });
          }
          return Response.json({ ok: true }, { status: 201 });
        },
        { mode: "transactional" },
      );
      const key = freshKey();
      const first = await send(path, { key });
      expect(first.status).toBe(firstAttempt === "throw" ? 500 : 429);
      expect((await send(path, { key })).status).toBe(201);
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBe(seen[0]);
    });
  }

  it("(c) a fail-open run (row 14) derives the key the same request gets with the store up", async () => {
    const routeTemplate = `/shared-${randomBytes(4).toString("hex")}`;
    const seen: { failOpen: string[]; normal: string[] } = {
      failOpen: [],
      normal: [],
    };
    const failOpen = mount(
      idemfence({ store: postgresStore({ pool: deadPool }) }),
      async (_request, ctx) => {
        seen.failOpen.push(await derive(ctx, "payment-charge"));
        return Response.json({ ok: true }, { status: 201 });
      },
      { routeTemplate, failOpen: true },
    );
    const normal = mount(
      idemfence(),
      async (_request, ctx) => {
        seen.normal.push(await derive(ctx, "payment-charge"));
        return Response.json({ ok: true }, { status: 201 });
      },
      { routeTemplate },
    );
    const key = freshKey();
    const mark = logs.length;
    expect((await send(failOpen, { key })).status).toBe(201);
    expect(logs.slice(mark)).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({ row: 14, outcome: "fail-open" }),
      }),
    ]);
    expect((await send(normal, { key })).status).toBe(201);
    expect(seen.failOpen).toHaveLength(1);
    expect(seen.normal).toEqual(seen.failOpen);
  });
});

describe("secret rotation", () => {
  const routeTemplate = `/rotation-${randomBytes(4).toString("hex")}`;
  const key = freshKey();

  /** The key the same request derives under a given secret configuration. */
  async function keyUnder(
    secret: string,
    previousSecrets: string[] = [],
  ): Promise<string> {
    const seen: string[] = [];
    // A release status leaves no record, so the next configuration runs the handler again.
    const path = mount(
      idemfence({ secret, previousSecrets }),
      async (_request, ctx) => {
        seen.push(await derive(ctx, "payment-charge"));
        return new Response("later", { status: 429 });
      },
      { routeTemplate },
    );
    expect((await send(path, { key })).status).toBe(429);
    expect(seen).toHaveLength(1);
    return seen[0] as string;
  }

  it("rotating in a new secret (the old one moved into previousSecrets) keeps every key", async () => {
    const before = await keyUnder(SECRET_A);
    expect(await keyUnder(SECRET_B, [SECRET_A])).toBe(before);
    expect(await keyUnder(SECRET_C, [SECRET_B, SECRET_A])).toBe(before);
  });

  it("with two previous secrets, the last (oldest) one is used", async () => {
    const oldest = await keyUnder(SECRET_A);
    const middle = await keyUnder(SECRET_B);
    expect(oldest).not.toBe(middle);
    expect(await keyUnder(SECRET_C, [SECRET_B, SECRET_A])).toBe(oldest);
  });

  it("removing the oldest secret changes the key: the documented deliberate re-key", async () => {
    const before = await keyUnder(SECRET_C, [SECRET_B, SECRET_A]);
    const after = await keyUnder(SECRET_C, [SECRET_B]);
    expect(after).not.toBe(before);
    // Now SECRET_B is the oldest, so the key is the one SECRET_B alone gives.
    expect(after).toBe(await keyUnder(SECRET_B));
  });
});

describe("what the key depends on", () => {
  it("a different label, principal, client key, route template or method each give a different key", async () => {
    const idem = idemfence();
    const capture =
      (into: string[], label = "payment-charge"): Handler =>
      async (_request, ctx) => {
        into.push(await derive(ctx, label));
        return new Response("later", { status: 429 });
      };
    const seen: Record<string, string[]> = {
      base: [],
      label: [],
      principal: [],
      clientKey: [],
      routeTemplate: [],
      method: [],
    };
    const key = freshKey();
    const shared = `/what-${randomBytes(4).toString("hex")}`;
    const basePath = mount(idem, capture(seen.base as string[]), {
      routeTemplate: shared,
    });
    const labelPath = mount(
      idem,
      capture(seen.label as string[], "payment-refund"),
      { routeTemplate: shared },
    );
    const principalPath = mount(idem, capture(seen.principal as string[]), {
      routeTemplate: shared,
    });
    const clientKeyPath = mount(idem, capture(seen.clientKey as string[]), {
      routeTemplate: shared,
    });
    const templatePath = mount(idem, capture(seen.routeTemplate as string[]), {
      routeTemplate: `${shared}-other`,
    });
    const methodPath = mount(idem, capture(seen.method as string[]), {
      routeTemplate: shared,
    });

    await send(basePath, { key });
    await send(labelPath, { key });
    await send(principalPath, { key, principal: "user-2" });
    await send(clientKeyPath, { key: `${key}-other` });
    await send(templatePath, { key });
    await send(methodPath, { key, method: "PATCH" });

    const values = Object.entries(seen).map(([name, list]) => {
      expect(list, name).toHaveLength(1);
      return list[0];
    });
    expect(new Set(values).size).toBe(6);
  });
});

describe("labels (DERIVE_LABEL_INVALID)", () => {
  const invalid: [string, unknown][] = [
    ["empty", ""],
    ["129 characters", "x".repeat(129)],
    ["a space", "payment charge"],
    ["non-ASCII", "paiement-réglé"],
    ["a tab", "payment\tcharge"],
    ["a NUL", "payment\u0000"],
    ["DEL (0x7F)", "payment\u007f"],
    ["not a string", 42],
  ];

  for (const mode of ["lease", "transactional"] as const) {
    it(`${mode} mode: rejects every invalid label with IdemfenceDeriveError and accepts 1 and 128 characters`, async () => {
      let results: Record<string, string> = {};
      const path = mount(
        idemfence(),
        async (_request, ctx) => {
          results = {};
          for (const [name, label] of invalid) {
            results[name] = await outcome(ctx.deriveKey(label as string));
          }
          results.one = await outcome(ctx.deriveKey("a"));
          results.max = await outcome(ctx.deriveKey(LONG_LABEL));
          return new Response("later", { status: 429 });
        },
        { mode },
      );
      expect((await send(path, { key: freshKey() })).status).toBe(429);
      expect(results).toEqual({
        ...Object.fromEntries(
          invalid.map(([name]) => [name, "DERIVE_LABEL_INVALID"]),
        ),
        one: "resolved",
        max: "resolved",
      });
    });
  }
});

describe("requests without a key (DERIVE_KEY_UNAVAILABLE)", () => {
  for (const mode of ["lease", "transactional"] as const) {
    it(`${mode} mode, optional-key route: deriveKey is present but rejects`, async () => {
      let result = "";
      let invalidLabel = "";
      const path = mount(
        idemfence(),
        async (_request, ctx) => {
          expect(typeof ctx.deriveKey).toBe("function");
          result = await outcome(ctx.deriveKey("payment-charge"));
          invalidLabel = await outcome(ctx.deriveKey("bad label"));
          return Response.json({ ok: true });
        },
        { mode, required: false },
      );
      expect((await send(path, {})).status).toBe(200);
      expect(result).toBe("DERIVE_KEY_UNAVAILABLE");
      // A bad label is reported as such, keyed or not.
      expect(invalidLabel).toBe("DERIVE_LABEL_INVALID");
    });
  }

  it("a method the adapter does not enforce: deriveKey is present but rejects", async () => {
    let result = "";
    const path = mount(idemfence(), async (_request, ctx) => {
      result = await outcome(ctx.deriveKey("payment-charge"));
      return Response.json({ ok: true });
    });
    expect((await send(path, { key: freshKey(), method: "GET" })).status).toBe(
      200,
    );
    expect(result).toBe("DERIVE_KEY_UNAVAILABLE");
  });
});

describe("the HMAC key", () => {
  it("is imported once per instance, non-extractable, and reused across calls and requests", async () => {
    const spy = vi.spyOn(globalThis.crypto.subtle, "importKey");
    try {
      const path = mount(idemfence(), async (_request, ctx) => {
        await derive(ctx, "payment-charge");
        await derive(ctx, "payment-refund");
        return new Response("later", { status: 429 });
      });
      await send(path, { key: freshKey() });
      await send(path, { key: freshKey() });
      expect(spy).toHaveBeenCalledTimes(1);
      const [format, , algorithm, extractable, usages] = spy.mock
        .calls[0] as unknown[];
      expect({ format, algorithm, extractable, usages }).toEqual({
        format: "raw",
        algorithm: { name: "HMAC", hash: "SHA-256" },
        extractable: false,
        usages: ["sign"],
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("derived keys stay out of what idemfence writes (contract section 8)", () => {
  it("a stored 500 after deriving (lease, row 12) and a rolled-back 500 (transactional, row 13) carry no derived key", async () => {
    const seen: string[] = [];
    const throws: Handler = async (_request, ctx) => {
      seen.push(await derive(ctx, "payment-charge"));
      throw new Error(`failed after deriving ${seen.at(-1)}`);
    };
    const lease = mount(idemfence(), throws);
    const transactional = mount(idemfence(), throws, {
      mode: "transactional",
    });
    const leaseKey = freshKey();
    const replies = [
      await send(lease, { key: leaseKey }),
      await send(lease, { key: leaseKey }),
      await send(transactional, { key: freshKey() }),
    ];
    expect(replies.map((reply) => reply.status)).toEqual([500, 500, 500]);
    expect(replies[1]?.headers.get("idempotent-replayed")).toBe("true");
    const stored = await pool.query<{ body: string; headers: unknown }>(
      `SELECT convert_from(response_body, 'UTF8') AS body, response_headers AS headers
       FROM ${records} WHERE response_status = 500`,
    );
    expect(stored.rowCount).toBeGreaterThan(0);
    const written = JSON.stringify({
      replies: replies.map((reply) => [reply.body, [...reply.headers]]),
      stored: stored.rows,
    });
    expect(seen).toHaveLength(2);
    for (const value of seen) {
      expect(written).not.toContain(value);
    }
  });

  // Last in the file on purpose: every request above has run.
  it("no log entry captured in this file contains any derived key", () => {
    expect(derived.size).toBeGreaterThan(10);
    expect(logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(logs);
    for (const value of derived) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
      expect(text).not.toContain(value);
    }
  });
});
