// An idemfence/fetch server in its own process, for tests that must freeze, resume or kill
// the process that holds a lease (SIGSTOP and SIGCONT in heartbeat.test.ts; SIGKILL in
// crash.test.ts). It runs the built package (dist/), so build before testing, as CI does.
//
// Configuration comes from the environment:
//   CHILD_DATABASE_URL  Postgres URL (required)
//   CHILD_SCHEMA        schema holding the idemfence tables (required)
//   CHILD_SECRET        idemfence secret, at least 32 bytes (required)
//   CHILD_ROUTE         path and route template served, for example /stall (required)
//   CHILD_LEASE         lease duration, for example "1s" (default "30s")
//   CHILD_MODE          "lease" (default) or "transactional"
//   CHILD_HANDLER       "until-abort" (default) or "crash"; see below
//   CHILD_KILL_AT       crash handler only: "P1", "P2", "P3" or "P4"; unset runs normally
//
// "until-abort": the handler reports "running", waits until ctx.signal aborts, reports
// "aborted" with the reason's name and code, and answers 201 {"from":"child"}.
//
// "crash": the handler inserts a row into CHILD_SCHEMA.executions for every invocation (on
// ctx.tx in transactional mode, on the pool in lease mode). In lease mode it also upserts
// a row of CHILD_SCHEMA.orders keyed by ctx.deriveKey("order"), the documented downstream
// pattern. It answers 201 {"execution": <executions id>}. With CHILD_KILL_AT set, the
// process stops at that point, tells the parent over IPC ({ "event": "kill-point",
// "point": "P1" }), and then waits forever for the parent's SIGKILL:
//   P1  begin has returned acquired; the handler has not started
//   P2  the handler has made its writes
//   P3  the handler has returned; complete has not been called
//   P4  complete (lease mode) or COMMIT (transactional mode) has resolved; no response
//       byte has been sent
// The points are reached by wrapping the real Postgres store; the library has no hooks.
//
// Events are written to stdout as one JSON object per line (kill points also go over IPC):
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
const schema = env.CHILD_SCHEMA;
const mode = env.CHILD_MODE ?? "lease";
const killAt = env.CHILD_KILL_AT;
const pool = new pg.Pool({ connectionString: env.CHILD_DATABASE_URL, max: 4 });
pool.on("error", () => {});

/** Reports the kill point to the parent, then never settles. */
const halt = (point) => {
  emit({ event: "kill-point", point });
  process.send?.({ event: "kill-point", point });
  return new Promise(() => {});
};

const real = postgresStore({ pool, schema });
const store = killAt
  ? {
      lockTimeoutMs: real.lockTimeoutMs,
      ready: () => real.ready(),
      async begin(...args) {
        const begun = await real.begin(...args);
        if (killAt === "P1" && begun.outcome === "acquired") {
          await halt("P1");
        }
        return begun;
      },
      renew: (...args) => real.renew(...args),
      async complete(...args) {
        if (killAt === "P3") {
          await halt("P3");
        }
        const completed = await real.complete(...args);
        if (killAt === "P4" && mode === "lease") {
          await halt("P4");
        }
        return completed;
      },
      release: (...args) => real.release(...args),
      purgeExpired: (...args) => real.purgeExpired(...args),
      async openTransaction() {
        const transaction = await real.openTransaction();
        if (killAt !== "P4" || mode !== "transactional") {
          return transaction;
        }
        return {
          executor: transaction.executor,
          rollback: () => transaction.rollback(),
          async commit() {
            await transaction.commit();
            await halt("P4");
          },
        };
      },
    }
  : real;

const idem = createIdemfence({
  store,
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

const untilAbort = async (_request, ctx) => {
  emit({ event: "running" });
  if (!ctx.signal.aborted) {
    await new Promise((resolve) => {
      ctx.signal.addEventListener("abort", resolve, { once: true });
    });
  }
  const reason = ctx.signal.reason;
  emit({ event: "aborted", name: reason?.name, code: reason?.code });
  return Response.json({ from: "child" }, { status: 201 });
};

const crash = async (request, ctx) => {
  // The round is the client's key, so the parent can count rows per round.
  const round = request.headers.get("idempotency-key");
  const inserted = await (ctx.tx ?? pool).query(
    `INSERT INTO "${schema}".executions (round) VALUES ($1) RETURNING id::text AS id`,
    [round],
  );
  if (mode === "lease") {
    await pool.query(
      `INSERT INTO "${schema}".orders (downstream_key, round) VALUES ($1, $2)
       ON CONFLICT (downstream_key) DO NOTHING`,
      [await ctx.deriveKey("order"), round],
    );
  }
  if (killAt === "P2") {
    await halt("P2");
  }
  return Response.json(
    { execution: Number(inserted.rows[0].id) },
    { status: 201 },
  );
};

const handle = idempotent(
  idem,
  { routeTemplate: route, mode },
  env.CHILD_HANDLER === "crash" ? crash : untilAbort,
);

const app = new Hono();
app.post(route, (c) => handle(c.req.raw));
serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
  emit({ event: "listening", port: info.port });
});
