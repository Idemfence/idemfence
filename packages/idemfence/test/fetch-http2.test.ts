import { randomBytes } from "node:crypto";
import http2 from "node:http2";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idempotent } from "../src/fetch.js";
import { createIdemfence, type Logger } from "../src/index.js";
import { postgresStore } from "../src/stores/postgres/index.js";
import { databaseUrl, migrate } from "./support/postgres.js";

const url = databaseUrl();
const schema = `idemfence_h2_${randomBytes(4).toString("hex")}`;
const SECRET = "http2-test-secret-0123456789-abcdefghijk";
const DOCS = "https://example.com/docs/idempotency";
const REQUEST_BODY_CAP = 64 * 1024;
const logger: Logger = { warn() {}, error() {} };

let pool: pg.Pool;
let server: ServerType;
let client: http2.ClientHttp2Session;
const calls = { orders: 0 };
const serverErrors: string[] = [];

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: url, max: 5 });
  await migrate(url, schema);
  const idem = createIdemfence({
    store: postgresStore({ pool, schema }),
    scope: (request) => request.headers.get("x-principal") ?? undefined,
    secret: SECRET,
    docsUrl: DOCS,
    logger,
    requestBodyCap: REQUEST_BODY_CAP,
  });
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
  const app = new Hono();
  app.all("/orders", (c) => orders(c.req.raw));

  // h2c: HTTP/2 over cleartext on Node's http2 server.
  const port = await new Promise<number>((resolve) => {
    server = serve(
      {
        fetch: app.fetch,
        createServer: http2.createServer,
        port: 0,
        hostname: "127.0.0.1",
      },
      (info) => resolve(info.port),
    );
  });
  for (const event of ["sessionError", "streamError", "error"] as const) {
    server.on(event, (error: unknown) => {
      serverErrors.push(
        `${event}: ${error instanceof Error ? `${error.name} ${(error as { code?: string }).code ?? ""} ${error.message}` : String(error)}`,
      );
    });
  }
  client = http2.connect(`http://127.0.0.1:${port}`);
  client.on("error", () => {});
});

afterAll(async () => {
  client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});

interface H2Result {
  status: number | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  streamError: string | undefined;
  rstCode: number;
  written: number;
}

/** One HTTP/2 request; `upload` streams chunks until the stream ends, for row 15. */
function h2(
  headers: http2.OutgoingHttpHeaders,
  body: string | undefined,
  upload?: { chunk: Buffer },
): Promise<H2Result> {
  return new Promise((resolve) => {
    const result: H2Result = {
      status: undefined,
      headers: {},
      body: "",
      streamError: undefined,
      rstCode: -1,
      written: 0,
    };
    const stream = client.request(headers);
    stream.on("response", (responseHeaders) => {
      result.status = Number(responseHeaders[":status"]);
      result.headers = { ...responseHeaders } as H2Result["headers"];
    });
    stream.on("data", (data: Buffer) => {
      result.body += data.toString("utf8");
    });
    stream.on("error", (error: Error & { code?: string }) => {
      result.streamError = `${error.code ?? error.name}: ${error.message}`;
    });
    stream.on("close", () => {
      result.rstCode = stream.rstCode;
      resolve(result);
    });
    if (upload === undefined) {
      stream.end(body);
      return;
    }
    const pump = () => {
      while (!stream.destroyed && !stream.writableEnded) {
        result.written += upload.chunk.length;
        if (!stream.write(upload.chunk)) {
          stream.once("drain", pump);
          return;
        }
      }
    };
    pump();
  });
}

const requestHeaders = (
  key: string,
  extra: http2.OutgoingHttpHeaders = {},
) => ({
  ":method": "POST",
  ":path": "/orders",
  "content-type": "application/json",
  "x-principal": "user-1",
  "idempotency-key": `"${key}"`,
  ...extra,
});

describe("HTTP/2 (h2c) through @hono/node-server", () => {
  it("row 6: the replay is byte-identical and marked", async () => {
    const key = `h2-${randomBytes(4).toString("hex")}`;
    const body = JSON.stringify({ amount: 1, note: "n".repeat(2_000) });
    const before = calls.orders;

    const first = await h2(requestHeaders(key), body);
    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();

    const replay = await h2(requestHeaders(key), body);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.headers["x-trace"]).toBe("t1");
    expect(replay.body).toBe(first.body);
    expect(calls.orders).toBe(before + 1);
  });

  it("row 15: a Content-Length over the cap is a 413; the Connection header is dropped and the stream closed", async () => {
    const key = `h2-${randomBytes(4).toString("hex")}`;
    const before = calls.orders;
    const declared = 1024 ** 3;
    const result = await h2(
      requestHeaders(key, { "content-length": String(declared) }),
      undefined,
      { chunk: Buffer.alloc(64 * 1024, 0x61) },
    );
    console.info(
      `http2 row 15 (content-length): status=${result.status} connection=${JSON.stringify(result.headers.connection)} rstCode=${result.rstCode} streamError=${result.streamError ?? "none"} written=${result.written} serverErrors=${JSON.stringify(serverErrors)}`,
    );
    expect(result.status).toBe(413);
    expect(result.written).toBeLessThan(declared / 8);
    expect(result.headers.connection).toBeUndefined();
    expect(result.streamError).toBeUndefined();
    expect(result.rstCode).toBe(0);
    expect(serverErrors).toStrictEqual([]);
    expect(calls.orders).toBe(before);
  });

  it("row 15: a streamed upload over the cap is a 413; the Connection header is dropped and the stream closed", async () => {
    const key = `h2-${randomBytes(4).toString("hex")}`;
    const before = calls.orders;
    const result = await h2(requestHeaders(key), undefined, {
      chunk: Buffer.alloc(64 * 1024, 0x61),
    });
    console.info(
      `http2 row 15 (streamed): status=${result.status} connection=${JSON.stringify(result.headers.connection)} rstCode=${result.rstCode} streamError=${result.streamError ?? "none"} written=${result.written} serverErrors=${JSON.stringify(serverErrors)}`,
    );
    expect(result.status).toBe(413);
    expect(result.written).toBeLessThan(128 * 1024 * 1024);
    expect(result.headers.connection).toBeUndefined();
    expect(result.streamError).toBeUndefined();
    expect(result.rstCode).toBe(0);
    expect(serverErrors).toStrictEqual([]);
    expect(calls.orders).toBe(before);
  });
});
