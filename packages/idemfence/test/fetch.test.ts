import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isBodyTooLargeResponse } from "../src/engine.js";
import { idempotent } from "../src/fetch.js";
import { lookupKey } from "../src/hash.js";
import { createIdemfence, type Idemfence, type Logger } from "../src/index.js";
import { postgresStore } from "../src/stores/postgres/index.js";
import { databaseUrl, migrate } from "./support/postgres.js";

const url = databaseUrl();
const schema = `idemfence_fetch_${randomBytes(4).toString("hex")}`;
const records = `"${schema}".idemfence_records`;
const SECRET = "fetch-test-secret-0123456789-abcdefghijk";
const DOCS = "https://example.com/docs/idempotency";
const REQUEST_BODY_CAP = 64 * 1024;

const logger: Logger = { warn() {}, error() {} };
let pool: pg.Pool;
let deadPool: pg.Pool;
let server: ServerType;
let base: string;
let port: number;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const calls = { orders: 0, slow: 0, release: 0, throws: 0, methods: 0 };
let slowStarted = deferred();
let slowGate = deferred();
let slowFinished = deferred();

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

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: url, max: 10 });
  await migrate(url, schema);
  deadPool = new pg.Pool({
    host: "127.0.0.1",
    port: await closedPort(),
    database: "none",
    user: "none",
    password: "none",
    connectionTimeoutMillis: 500,
  });
  deadPool.on("error", () => {});

  const options = {
    scope: (request: Request) =>
      request.headers.get("x-principal") ?? undefined,
    secret: SECRET,
    docsUrl: DOCS,
    logger,
    requestBodyCap: REQUEST_BODY_CAP,
  };
  const idem: Idemfence = createIdemfence({
    ...options,
    store: postgresStore({ pool, schema }),
  });
  const dead: Idemfence = createIdemfence({
    ...options,
    store: postgresStore({ pool: deadPool }),
  });

  const app = new Hono();
  const orders = idempotent(
    idem,
    { routeTemplate: "/orders" },
    async (request) => {
      calls.orders += 1;
      const echo = await request.text();
      return Response.json(
        { id: 42, echo },
        { status: 201, headers: { "x-trace": "t1" } },
      );
    },
  );
  const slow = idempotent(idem, { routeTemplate: "/slow" }, async () => {
    calls.slow += 1;
    slowStarted.resolve();
    await slowGate.promise;
    const response = Response.json({ slow: true }, { status: 201 });
    slowFinished.resolve();
    return response;
  });
  const release = idempotent(idem, { routeTemplate: "/release" }, async () => {
    calls.release += 1;
    return new Response("later", {
      status: 429,
      headers: { "retry-after": "3" },
    });
  });
  const throws = idempotent(idem, { routeTemplate: "/throws" }, async () => {
    calls.throws += 1;
    throw new Error("boom");
  });
  const methods = idempotent(
    idem,
    { routeTemplate: "/methods", methods: ["PUT"] },
    async (request) => {
      calls.methods += 1;
      return new Response(`handled ${request.method}`);
    },
  );
  const unavailable = idempotent(
    dead,
    { routeTemplate: "/unavailable" },
    async () => Response.json({ never: true }),
  );
  // A handler's own 413 that imitates the engine's problem response, headers included.
  const own413 = idempotent(
    idem,
    { routeTemplate: "/own413" },
    async (request) => {
      await request.text();
      return new Response(
        JSON.stringify({ type: `${DOCS}#body-too-large`, status: 413 }),
        {
          status: 413,
          headers: {
            "content-type": "application/problem+json",
            link: `<${DOCS}#body-too-large>; rel="describedby"`,
          },
        },
      );
    },
  );
  app.all("/orders", (c) => orders(c.req.raw));
  app.all("/slow", (c) => slow(c.req.raw));
  app.all("/release", (c) => release(c.req.raw));
  app.all("/throws", (c) => throws(c.req.raw));
  app.all("/methods", (c) => methods(c.req.raw));
  app.all("/unavailable", (c) => unavailable(c.req.raw));
  app.all("/own413", (c) => own413(c.req.raw));

  port = await new Promise<number>((resolve) => {
    server = serve(
      { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
      (info) => resolve(info.port),
    );
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deadPool.end();
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});

let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `k-${process.pid}-${keyCounter}-${randomBytes(3).toString("hex")}`;
}

function headers(
  key?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "x-principal": "user-1",
    "content-type": "application/json",
    ...(key === undefined ? {} : { "idempotency-key": `"${key}"` }),
    ...extra,
  };
}

async function record(key: string, template: string, method = "POST") {
  const lk = await lookupKey({
    namespace: "idemfence",
    principal: "user-1",
    method,
    routeTemplate: template,
    clientKey: key,
  });
  const result = await pool.query(
    `SELECT state, attempts, response_status FROM ${records} WHERE lookup_key = $1`,
    [Buffer.from(lk)],
  );
  return result.rows[0];
}

async function expectProblem(response: Response, status: number, kind: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.status).toBe(status);
  if (kind === "about:blank") {
    expect(body.type).toBe("about:blank");
    expect(response.headers.get("link")).toBeNull();
  } else {
    expect(body.type).toBe(`${DOCS}#${kind}`);
    expect(response.headers.get("link")).toBe(
      `<${DOCS}#${kind}>; rel="describedby"`,
    );
  }
  return body;
}

describe("row 1: methods", () => {
  it("GET passes through untouched, with no record", async () => {
    const before = calls.orders;
    const response = await fetch(`${base}/orders`, {
      headers: headers(freshKey()),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("idempotent-replayed")).toBeNull();
    expect(calls.orders).toBe(before + 1);
  });

  it("an unlisted method passes through even with a key; listed methods are enforced", async () => {
    const key = freshKey();
    const put = await fetch(`${base}/orders`, {
      method: "PUT",
      headers: headers(key),
      body: "{}",
    });
    expect(put.status).toBe(201);
    expect(await record(key, "/orders", "PUT")).toBeUndefined();

    const post = await fetch(`${base}/methods`, {
      method: "POST",
      headers: headers(),
      body: "{}",
    });
    expect(await post.text()).toBe("handled POST");

    const enforced = await fetch(`${base}/methods`, {
      method: "PUT",
      headers: headers(),
      body: "{}",
    });
    await expectProblem(enforced, 400, "key-missing");
  });
});

describe("rows 2, 3, 5 to 8, 11, 12, 14, 15 over HTTP", () => {
  it("row 2: missing key", async () => {
    const response = await fetch(`${base}/orders`, {
      method: "POST",
      headers: headers(),
      body: "{}",
    });
    await expectProblem(response, 400, "key-missing");
  });

  it("row 3: malformed key", async () => {
    const response = await fetch(`${base}/orders`, {
      method: "POST",
      headers: headers(undefined, { "idempotency-key": "not-quoted" }),
      body: "{}",
    });
    await expectProblem(response, 400, "key-malformed");
  });

  it("rows 5 and 6: the handler reads the full body; the replay is byte-identical", async () => {
    const key = freshKey();
    const body = JSON.stringify({ amount: 1, note: "x".repeat(10_000) });
    const before = calls.orders;

    const first = await fetch(`${base}/orders`, {
      method: "POST",
      headers: headers(key),
      body,
    });
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    expect(
      (JSON.parse(new TextDecoder().decode(firstBytes)) as { echo: string })
        .echo,
    ).toBe(body);

    const replay = await fetch(`${base}/orders`, {
      method: "POST",
      headers: headers(key),
      body,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.headers.get("x-trace")).toBe("t1");
    expect(new Uint8Array(await replay.arrayBuffer())).toStrictEqual(
      firstBytes,
    );
    expect(calls.orders).toBe(before + 1);
    expect(await record(key, "/orders")).toMatchObject({
      state: "completed",
      response_status: 201,
    });
  });

  it("row 5: a chunked upload reaches the handler in full", async () => {
    const parts = ['{"a":', '"', "y".repeat(5_000), '"}'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(new TextEncoder().encode(part));
        }
        controller.close();
      },
    });
    const response = await fetch(`${base}/orders`, {
      method: "POST",
      headers: headers(freshKey()),
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { echo: string }).echo).toBe(
      parts.join(""),
    );
  });

  it("row 7: same key, different body", async () => {
    const key = freshKey();
    await fetch(`${base}/orders`, {
      method: "POST",
      headers: headers(key),
      body: '{"n":1}',
    });
    const response = await fetch(`${base}/orders`, {
      method: "POST",
      headers: headers(key),
      body: '{"n":2}',
    });
    await expectProblem(response, 422, "key-reused");
  });

  it("row 8: a concurrent request during a slow handler is a 409 with an integer Retry-After", async () => {
    const key = freshKey();
    slowStarted = deferred();
    slowGate = deferred();
    slowFinished = deferred();
    const first = fetch(`${base}/slow`, {
      method: "POST",
      headers: headers(key),
      body: "{}",
    });
    await slowStarted.promise;

    const second = await fetch(`${base}/slow`, {
      method: "POST",
      headers: headers(key),
      body: "{}",
    });
    await expectProblem(second, 409, "in-flight");
    expect(second.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);

    slowGate.resolve();
    expect((await first).status).toBe(201);
  });

  it("row 11: a release status is returned as-is and the key can be retried", async () => {
    const key = freshKey();
    const before = calls.release;
    const response = await fetch(`${base}/release`, {
      method: "POST",
      headers: headers(key),
      body: "{}",
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.text()).toBe("later");
    expect(await record(key, "/release")).toBeUndefined();
    await fetch(`${base}/release`, {
      method: "POST",
      headers: headers(key),
      body: "{}",
    });
    expect(calls.release).toBe(before + 2);
  });

  it("row 12: a thrown error is a stored about:blank 500 that replays", async () => {
    const key = freshKey();
    const before = calls.throws;
    const response = await fetch(`${base}/throws`, {
      method: "POST",
      headers: headers(key),
      body: "{}",
    });
    await expectProblem(response, 500, "about:blank");
    const replay = await fetch(`${base}/throws`, {
      method: "POST",
      headers: headers(key),
      body: "{}",
    });
    expect(replay.status).toBe(500);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(calls.throws).toBe(before + 1);
  });

  it("row 14: an unreachable store is a 503 with Retry-After", async () => {
    const response = await fetch(`${base}/unavailable`, {
      method: "POST",
      headers: headers(freshKey()),
      body: "{}",
    });
    await expectProblem(response, 503, "store-unavailable");
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("row 15: an oversized body is a 413 with Connection: close", async () => {
    const response = await fetch(`${base}/orders`, {
      method: "POST",
      headers: headers(freshKey()),
      body: "x".repeat(REQUEST_BODY_CAP + 1),
    });
    await expectProblem(response, 413, "body-too-large");
    expect(response.headers.get("connection")).toBe("close");
  });
});

/** Streams an upload on a raw socket until the server closes it; returns what came back. */
async function uploadUntilClosed(head: string, chunk: Buffer, framed: boolean) {
  const socket: Socket = connect(port, "127.0.0.1");
  // EPIPE/ECONNRESET are expected once the server closes the connection.
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let closed = false;
  const closedPromise = new Promise<void>((resolve) => {
    socket.once("close", () => {
      closed = true;
      resolve();
    });
  });
  let response = "";
  socket.on("data", (data: Buffer) => {
    response += data.toString("latin1");
  });
  const startedAt = Date.now();
  socket.write(head);
  let written = 0;
  while (!closed && !socket.destroyed) {
    const payload = framed
      ? Buffer.concat([
          Buffer.from(`${chunk.length.toString(16)}\r\n`),
          chunk,
          Buffer.from("\r\n"),
        ])
      : chunk;
    const ok = socket.write(payload);
    written += chunk.length;
    if (!ok) {
      await Promise.race([
        new Promise<void>((resolve) => socket.once("drain", resolve)),
        closedPromise,
      ]);
    }
  }
  await closedPromise;
  const elapsedMs = Date.now() - startedAt;
  console.info(
    `row 15 (${framed ? "chunked" : "content-length"}): wrote ${written} bytes before the server closed the connection after ${elapsedMs} ms`,
  );
  return { response, written, elapsedMs };
}

describe("row 15 marker", () => {
  it("a handler's own 413 is never given Connection: close, whatever its headers", async () => {
    const response = await fetch(`${base}/own413`, {
      method: "POST",
      headers: headers(freshKey()),
      body: "{}",
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("link")).toBe(
      `<${DOCS}#body-too-large>; rel="describedby"`,
    );
    expect(response.headers.get("connection")).not.toBe("close");
  });

  it("only the engine's row-15 response carries the marker", async () => {
    const idem = createIdemfence({
      store: postgresStore({ pool, schema }),
      scope: () => "user-1",
      secret: SECRET,
      docsUrl: DOCS,
      logger,
      requestBodyCap: 8,
    });
    const engine413 = await idem.handle(
      new Request("https://api.example.com/x", {
        method: "POST",
        headers: { "idempotency-key": `"${freshKey()}"` },
        body: "x".repeat(9),
      }),
      { routeTemplate: "/x" },
      async () => new Response(),
    );
    expect(engine413.status).toBe(413);
    expect(isBodyTooLargeResponse(engine413)).toBe(true);
    expect(isBodyTooLargeResponse(new Response("mine", { status: 413 }))).toBe(
      false,
    );
  });
});

describe("row 15 over a raw socket", () => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);

  it("a Content-Length over the cap: 413, Connection: close, the upload is not read", async () => {
    const declared = 1024 ** 3;
    const before = calls.orders;
    const head =
      `POST /orders HTTP/1.1\r\nHost: 127.0.0.1\r\nIdempotency-Key: "${freshKey()}"\r\n` +
      `X-Principal: user-1\r\nContent-Type: application/octet-stream\r\nContent-Length: ${declared}\r\n\r\n`;
    const { response, written, elapsedMs } = await uploadUntilClosed(
      head,
      chunk,
      false,
    );

    expect(response).toMatch(/^HTTP\/1\.1 413 /);
    expect(response.toLowerCase()).toContain("\r\nconnection: close\r\n");
    expect(written).toBeLessThan(declared / 8);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(calls.orders).toBe(before);
  });

  it("a chunked upload over the cap: 413, Connection: close, the connection is closed early", async () => {
    const before = calls.orders;
    const head =
      `POST /orders HTTP/1.1\r\nHost: 127.0.0.1\r\nIdempotency-Key: "${freshKey()}"\r\n` +
      "X-Principal: user-1\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n";
    const { response, written, elapsedMs } = await uploadUntilClosed(
      head,
      chunk,
      true,
    );

    expect(response).toMatch(/^HTTP\/1\.1 413 /);
    expect(response.toLowerCase()).toContain("\r\nconnection: close\r\n");
    expect(written).toBeLessThan(128 * 1024 * 1024);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(calls.orders).toBe(before);
  });
});

describe("row 16: client disconnect", () => {
  it("the handler still completes, the record is stored, and a retry replays it", async () => {
    const key = freshKey();
    slowStarted = deferred();
    slowGate = deferred();
    slowFinished = deferred();
    const controller = new AbortController();
    const aborted = fetch(`${base}/slow`, {
      method: "POST",
      headers: headers(key),
      body: "{}",
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await slowStarted.promise;
    controller.abort();
    expect(await aborted).toBeInstanceOf(Error);

    slowGate.resolve();
    await slowFinished.promise;
    for (
      let i = 0;
      i < 50 && (await record(key, "/slow"))?.state !== "completed";
      i += 1
    ) {
      await sleep(20);
    }
    expect(await record(key, "/slow")).toMatchObject({
      state: "completed",
      response_status: 201,
    });

    const before = calls.slow;
    const replay = await fetch(`${base}/slow`, {
      method: "POST",
      headers: headers(key),
      body: "{}",
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toStrictEqual({ slow: true });
    expect(calls.slow).toBe(before);
  });
});

describe("the built package", () => {
  it("exposes createIdemfence from idemfence and idempotent from idemfence/fetch", async () => {
    const packageDir = fileURLToPath(new URL("..", import.meta.url));
    const script = `
      const root = await import("idemfence");
      const fetchAdapter = await import("idemfence/fetch");
      console.log(JSON.stringify({
        root: Object.keys(root).sort(),
        fetch: Object.keys(fetchAdapter).sort(),
        createIdemfence: typeof root.createIdemfence,
        idempotent: typeof fetchAdapter.idempotent,
      }));
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: packageDir },
    );
    expect(JSON.parse(stdout)).toStrictEqual({
      root: [
        "IdemfenceConfigError",
        "IdemfenceDeriveError",
        "IdemfenceFencedError",
        "IdemfenceStoreError",
        "createIdemfence",
      ],
      fetch: ["idempotent"],
      createIdemfence: "function",
      idempotent: "function",
    });
  });
});

describe("route methods validation", () => {
  it("rejects an empty or malformed methods list at wrap time", () => {
    const idem = createIdemfence({
      store: postgresStore({ pool, schema }),
      scope: () => "user-1",
      secret: SECRET,
      docsUrl: DOCS,
      logger,
    });
    for (const methods of [[], ["POST", "pa tch"], ["PO:ST"], "POST", [1]]) {
      expect(() =>
        idempotent(
          idem,
          { routeTemplate: "/x", methods: methods as string[] },
          async () => new Response(),
        ),
      ).toThrow(expect.objectContaining({ code: "ROUTE_METHODS_INVALID" }));
    }
  });
});
