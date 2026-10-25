import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  createIdemfence,
  type Idemfence,
  IdemfenceConfigError,
} from "idemfence";
import { idempotent } from "idemfence/fetch";
import { postgresStore } from "idemfence/postgres";
import pg from "pg";

// Configuration comes from the environment only; see README.md. Validation fails fast with
// one message listing every problem.
interface Config {
  databaseUrl: string;
  secret: string;
  docsUrl: string;
  port: number;
}

function readConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL must be a postgres:// connection URL");
  }
  const secret = env.IDEMFENCE_SECRET ?? "";
  if (Buffer.byteLength(secret) < 32) {
    problems.push(
      "IDEMFENCE_SECRET must be set to at least 32 bytes (no default)",
    );
  }
  const docsUrl = env.DOCS_URL ?? "";
  if (!docsUrl.startsWith("https://")) {
    problems.push(
      "DOCS_URL must be an https:// URL to your published idempotency documentation",
    );
  }
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push("PORT must be an integer from 1 to 65535");
  }
  if (problems.length > 0) {
    throw new Error(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
  return { databaseUrl, secret, docsUrl, port };
}

// The conformance suite identifies the caller with an X-Principal header. A real application
// MUST derive the principal from its authentication (session, token, API key), never from a
// header the client controls: with a client-chosen principal, anyone could replay or block
// another caller's keys. A real application also rejects unauthenticated requests before
// idemfence runs (401); this app deliberately lets a missing header reach idemfence so the
// conformance suite can verify contract row 4.
const PRINCIPAL = /^[\x21-\x7e]{1,64}$/;

let config: Config;
try {
  config = readConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on("error", (error) => {
  console.error("pg pool error", { name: error.name, message: error.message });
});

const store = postgresStore({ pool });
const scope = (request: Request) =>
  request.headers.get("x-principal") ?? undefined;

let idem: Idemfence;
let shortRetentionIdem: Idemfence;
try {
  idem = createIdemfence({
    store,
    scope,
    secret: config.secret,
    docsUrl: config.docsUrl,
  });
  // The short-retention fixture (contract row 10) needs its own lease and retention.
  shortRetentionIdem = createIdemfence({
    store,
    scope,
    secret: config.secret,
    docsUrl: config.docsUrl,
    lease: "500ms",
    retention: "1500ms",
  });
} catch (error) {
  if (error instanceof IdemfenceConfigError) {
    console.error(
      `idemfence configuration error ${error.code}: ${error.message}`,
    );
    process.exit(1);
  }
  throw error;
}

// --- Orders -------------------------------------------------------------------------------

interface CreateOrder {
  item: string;
  simulateWorkMs: number;
}

function parseCreateOrder(body: unknown): CreateOrder | string {
  if (typeof body !== "object" || body === null) {
    return "body must be a JSON object";
  }
  const { item, simulateWorkMs } = body as {
    item?: unknown;
    simulateWorkMs?: unknown;
  };
  if (typeof item !== "string" || item.length < 1 || item.length > 200) {
    return "item must be a string of 1 to 200 characters";
  }
  if (
    simulateWorkMs !== undefined &&
    (!Number.isInteger(simulateWorkMs) ||
      (simulateWorkMs as number) < 0 ||
      (simulateWorkMs as number) > 30_000)
  ) {
    return "simulateWorkMs must be an integer from 0 to 30000";
  }
  return { item, simulateWorkMs: (simulateWorkMs as number | undefined) ?? 0 };
}

/** Inserts one order, waits the simulated work, returns 201 { id, item }. */
async function createOrderHandler(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  const order = parseCreateOrder(body);
  if (typeof order === "string") {
    return Response.json({ error: order }, { status: 400 });
  }
  const inserted = await pool.query<{ id: string }>(
    "INSERT INTO orders (item) VALUES ($1) RETURNING id::text AS id",
    [order.item],
  );
  if (order.simulateWorkMs > 0) {
    await sleep(order.simulateWorkMs);
  }
  return Response.json(
    { id: Number(inserted.rows[0]?.id), item: order.item },
    { status: 201 },
  );
}

async function releaseHandler(): Promise<Response> {
  return new Response("later", {
    status: 429,
    headers: { "retry-after": "1" },
  });
}

async function throwsHandler(): Promise<Response> {
  throw new Error("the fixture handler always throws");
}

async function passthroughHandler(request: Request): Promise<Response> {
  return Response.json({ echo: await request.text() });
}

// --- Routes -------------------------------------------------------------------------------

const app = new Hono();

app.get("/healthz", async (c) => {
  try {
    await idem.ready();
    return c.json({ status: "ok" });
  } catch (error) {
    return c.json(
      {
        status: "unavailable",
        reason: error instanceof Error ? error.name : "unknown",
      },
      503,
    );
  }
});

app.get("/orders/count", async (c) => {
  const result = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM orders",
  );
  return c.json({ count: result.rows[0]?.count ?? 0 });
});

// An X-Principal that is present but malformed is a client error; a missing one reaches
// idemfence (see the note on PRINCIPAL above).
app.use("*", async (c, next) => {
  const principal = c.req.header("x-principal");
  if (principal !== undefined && !PRINCIPAL.test(principal)) {
    return c.json(
      {
        error:
          "X-Principal must be 1 to 64 printable ASCII characters (no spaces)",
      },
      400,
    );
  }
  await next();
});

// Idempotent routes: the main endpoint and the conformance fixtures.
const createOrder = idempotent(
  idem,
  { routeTemplate: "/orders" },
  createOrderHandler,
);
const release = idempotent(
  idem,
  { routeTemplate: "/fixtures/release" },
  releaseHandler,
);
const throws = idempotent(
  idem,
  { routeTemplate: "/fixtures/throws" },
  throwsHandler,
);
const shortRetention = idempotent(
  shortRetentionIdem,
  { routeTemplate: "/fixtures/short-retention" },
  createOrderHandler,
);
app.post("/orders", (c) => createOrder(c.req.raw));
app.post("/fixtures/release", (c) => release(c.req.raw));
app.post("/fixtures/throws", (c) => throws(c.req.raw));
app.post("/fixtures/short-retention", (c) => shortRetention(c.req.raw));
// Not idempotent on purpose: contract row 1 (passthrough).
app.post("/fixtures/passthrough", (c) => passthroughHandler(c.req.raw));

// Deliberately NON-conforming: the same handlers with no idemfence, so the conformance
// suite can be shown failing. Never do this in a real application.
const nonconforming = new Hono();
nonconforming.post("/orders", (c) => createOrderHandler(c.req.raw));
nonconforming.post("/release", () => releaseHandler());
nonconforming.post("/throws", () => throwsHandler());
nonconforming.post("/short-retention", (c) => createOrderHandler(c.req.raw));
nonconforming.post("/passthrough", (c) => passthroughHandler(c.req.raw));
app.route("/nonconforming", nonconforming);

const server = serve(
  { fetch: app.fetch, port: config.port, hostname: "0.0.0.0" },
  (info) => {
    console.log(
      `idemfence reference app listening on ${info.address}:${info.port}`,
    );
  },
);

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}; shutting down`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
