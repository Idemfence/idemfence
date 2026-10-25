// An idemfence/fetch server in its own process, for tests that must freeze, resume or kill
// the process that holds a lease (SIGSTOP and SIGCONT in heartbeat.test.ts; SIGKILL in the
// crash group). It runs the built package (dist/), so build before testing, as CI does.
//
// Configuration comes from the environment:
//   CHILD_DATABASE_URL  Postgres URL (required)
//   CHILD_SCHEMA        schema holding the idemfence tables (required)
//   CHILD_SECRET        idemfence secret, at least 32 bytes (required)
//   CHILD_ROUTE         path and route template served, for example /stall (required)
//   CHILD_LEASE         lease duration, for example "1s" (default "30s")
//   CHILD_MODE          "lease" (default) or "transactional"
//
// Every request on CHILD_ROUTE runs the same handler: it reports "running", waits until
// ctx.signal aborts, reports "aborted" with the reason's name and code, and answers 201
// {"from":"child"}. Events are written to stdout as one JSON object per line:
//   { "event": "listening", "port": n }
//   { "event": "running" }
//   { "event": "aborted", "name": "...", "code": "..." }
//   { "event": "log", "level": "warn" | "error", "message": "...", "fields": {...} }
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import pg from "pg";
import { idempotent } from "../../dist/fetch.js";
import { createIdemfence } from "../../dist/index.js";
import { postgresStore } from "../../dist/stores/postgres/index.js";

const emit = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const env = process.env;
const route = env.CHILD_ROUTE;
const pool = new pg.Pool({ connectionString: env.CHILD_DATABASE_URL, max: 4 });
pool.on("error", () => {});

const idem = createIdemfence({
  store: postgresStore({ pool, schema: env.CHILD_SCHEMA }),
  scope: (request) => request.headers.get("x-principal") ?? undefined,
  secret: env.CHILD_SECRET,
  docsUrl: "https://example.com/docs/idempotency",
  lease: env.CHILD_LEASE ?? "30s",
  logger: {
    warn: (message, fields) =>
      emit({ event: "log", level: "warn", message, fields }),
    error: (message, fields) =>
      emit({ event: "log", level: "error", message, fields }),
  },
});

const handle = idempotent(
  idem,
  { routeTemplate: route, mode: env.CHILD_MODE ?? "lease" },
  async (_request, ctx) => {
    emit({ event: "running" });
    if (!ctx.signal.aborted) {
      await new Promise((resolve) => {
        ctx.signal.addEventListener("abort", resolve, { once: true });
      });
    }
    const reason = ctx.signal.reason;
    emit({ event: "aborted", name: reason?.name, code: reason?.code });
    return Response.json({ from: "child" }, { status: 201 });
  },
);

const app = new Hono();
app.post(route, (c) => handle(c.req.raw));
serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
  emit({ event: "listening", port: info.port });
});
