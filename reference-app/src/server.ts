import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createIdemfence, IdemfenceConfigError } from "idemfence";
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
// another caller's keys.
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

let idem: ReturnType<typeof createIdemfence>;
try {
  idem = createIdemfence({
    store: postgresStore({ pool }),
    scope: (request) => request.headers.get("x-principal") ?? undefined,
    secret: config.secret,
    docsUrl: config.docsUrl,
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

const createOrder = idempotent(
  idem,
  { routeTemplate: "/orders" },
  async (request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "body must be valid JSON" },
        { status: 400 },
      );
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
  },
);

app.post("/orders", async (c) => {
  const principal = c.req.header("x-principal") ?? "";
  if (!PRINCIPAL.test(principal)) {
    return c.json(
      {
        error:
          "X-Principal must be 1 to 64 printable ASCII characters (no spaces)",
      },
      400,
    );
  }
  return await createOrder(c.req.raw);
});

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
