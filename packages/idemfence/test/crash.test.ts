// The white-box crash group (docs/contract.md section 7, rows 8, 9 and 13): a real child
// process (support/child-server.mjs) is SIGKILLed at four points of a request, a fresh child
// is started on the same database, and the client retries with the same key and body.
// Real Postgres, real HTTP, no mocks; waits are on child events and on the store's clock.
//
// CRASH_ROUNDS sets the rounds per point and mode (default 3); CI's crash job runs 25.
// CRASH_SUMMARY, when set, names a file the per-point counts are written to.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lookupKey } from "../src/hash.js";
import { type ChildServer, startChildServer } from "./support/child.js";
import { databaseUrl, migrate } from "./support/postgres.js";

const url = databaseUrl();
const schema = `idemfence_crash_${randomBytes(4).toString("hex")}`;
const records = `"${schema}".idemfence_records`;
const SECRET = "crash-test-secret-0123456789-abcdefghijkl";
const LEASE = "1s";
const ROUNDS = Number(process.env.CRASH_ROUNDS ?? 3);
const POINTS = ["P1", "P2", "P3", "P4"] as const;
const MODES = ["lease", "transactional"] as const;
// A retry sent with more than this much lease left must be a 409: covers the request's
// travel time to the server's begin.
const SURE_LEASE_MS = 200;

type Point = (typeof POINTS)[number];
type Mode = (typeof MODES)[number];

let pool: pg.Pool;
const children = new Set<ChildServer>();

/** Observed per round, aggregated for the summary printed after the file. */
interface RoundStats {
  executions: number;
  orders: number;
  conflicts: number;
}
const stats = new Map<string, RoundStats[]>();

beforeAll(async () => {
  if (!Number.isInteger(ROUNDS) || ROUNDS < 1) {
    throw new Error(`CRASH_ROUNDS must be a positive integer, got ${ROUNDS}`);
  }
  pool = new pg.Pool({ connectionString: url, max: 4 });
  pool.on("error", () => {});
  await migrate(url, schema);
  await pool.query(
    `CREATE TABLE "${schema}".executions (id bigserial PRIMARY KEY, round text NOT NULL)`,
  );
  await pool.query(
    `CREATE TABLE "${schema}".orders (downstream_key text PRIMARY KEY, round text NOT NULL)`,
  );
});

afterAll(async () => {
  await Promise.all([...children].map((child) => child.kill()));
  const summary: Record<string, unknown> = {};
  for (const [name, rounds] of stats) {
    const range = (pick: (round: RoundStats) => number) => {
      const values = rounds.map(pick);
      const low = Math.min(...values);
      const high = Math.max(...values);
      return low === high ? String(low) : `${low}-${high}`;
    };
    summary[name] = {
      rounds: rounds.length,
      executions: range((r) => r.executions),
      orders: range((r) => r.orders),
      conflicts: range((r) => r.conflicts),
    };
  }
  // CRASH_SUMMARY names a file for the per-point counts (CI prints it).
  if (process.env.CRASH_SUMMARY !== undefined) {
    writeFileSync(
      process.env.CRASH_SUMMARY,
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  }
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});

async function start(
  mode: Mode,
  route: string,
  killAt?: Point,
): Promise<ChildServer> {
  const child = await startChildServer({
    databaseUrl: url,
    schema,
    secret: SECRET,
    route,
    lease: LEASE,
    mode,
    handler: "crash",
    ...(killAt === undefined ? {} : { killAt }),
  });
  children.add(child);
  return child;
}

async function kill(child: ChildServer): Promise<void> {
  await child.kill();
  children.delete(child);
}

interface Reply {
  status: number;
  headers: Headers;
  body: string;
}

async function send(child: ChildServer, route: string, key: string) {
  const response = await fetch(`${child.url}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-principal": "user-1",
      "idempotency-key": `"${key}"`,
    },
    body: '{"item":"widget"}',
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  } satisfies Reply;
}

async function counts(
  key: string,
): Promise<{ executions: number; orders: number }> {
  // The child records the raw header value, quotes included.
  const round = `"${key}"`;
  const result = await pool.query<{ executions: number; orders: number }>(
    `SELECT (SELECT count(*)::int FROM "${schema}".executions WHERE round = $1) AS executions,
            (SELECT count(*)::int FROM "${schema}".orders WHERE round = $1) AS orders`,
    [round],
  );
  return result.rows[0] ?? { executions: -1, orders: -1 };
}

interface RecordRow {
  attempts: number;
  body: string | null;
  lease_left_ms: number | null;
}

async function recordRows(route: string, key: string): Promise<RecordRow[]> {
  const lk = await lookupKey({
    namespace: "idemfence",
    principal: "user-1",
    method: "POST",
    routeTemplate: route,
    clientKey: key,
  });
  const result = await pool.query<RecordRow>(
    `SELECT attempts, convert_from(response_body, 'UTF8') AS body,
            EXTRACT(EPOCH FROM (lease_expires_at - clock_timestamp())) * 1000 AS lease_left_ms
     FROM ${records} WHERE lookup_key = $1`,
    [Buffer.from(lk)],
  );
  return result.rows.map((row) => ({
    ...row,
    lease_left_ms:
      row.lease_left_ms === null ? null : Number(row.lease_left_ms),
  }));
}

/**
 * One round: a child killed at `point` while serving the request, a fresh child, and the
 * retries. Returns what was observed.
 */
async function round(mode: Mode, point: Point): Promise<RoundStats> {
  const route = `/crash-${randomBytes(4).toString("hex")}`;
  const key = `crash-${randomBytes(8).toString("hex")}`;

  const doomed = await start(mode, route, point);
  const lost = send(doomed, route, key).then(
    () => "answered",
    () => "connection lost",
  );
  await doomed.waitFor(
    (event) => event.event === "kill-point" && event.via === "ipc",
  );
  await kill(doomed);
  // No response byte left the killed child, whatever the point.
  expect(await lost).toBe("connection lost");

  const survivor = await start(mode, route);
  let conflicts = 0;
  try {
    if (mode === "lease" && point !== "P4") {
      // Until the store's clock passes the killed attempt's lease, every retry is a 409.
      const deadline = Date.now() + 10_000;
      let reply: Reply;
      for (;;) {
        const before = await recordRows(route, key);
        const leaseLeft = before[0]?.lease_left_ms ?? 0;
        reply = await send(survivor, route, key);
        if (reply.status !== 409) {
          // A takeover requires the lease to have expired on the store's clock.
          expect(leaseLeft).toBeLessThanOrEqual(SURE_LEASE_MS);
          break;
        }
        conflicts += 1;
        expect(reply.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
        if (leaseLeft <= 0) {
          throw new Error(`409 after the lease expired (${leaseLeft} ms left)`);
        }
        if (Date.now() > deadline) {
          throw new Error("no takeover within 10 s");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(reply.status).toBe(201);
      expect(reply.headers.get("idempotent-replayed")).toBeNull();
      const stored = await recordRows(route, key);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.attempts).toBe(2);
      expect(stored[0]?.body).toBe(reply.body);
      const replay = await send(survivor, route, key);
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      expect(replay.body).toBe(reply.body);
      const seen = await counts(key);
      expect(seen.executions).toBe(point === "P1" ? 1 : 2);
      expect(seen.orders).toBe(1);
      return { ...seen, conflicts };
    }

    const first = await send(survivor, route, key);
    if (point === "P4") {
      // The killed attempt's outcome was stored before it died: the retry replays it.
      expect(first.status).toBe(201);
      expect(first.headers.get("idempotent-replayed")).toBe("true");
      const stored = await recordRows(route, key);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.attempts).toBe(1);
      expect(first.body).toBe(stored[0]?.body);
    } else {
      // Transactional P1 to P3: the killed transaction rolled back, so the key is free and
      // the very first retry runs the handler.
      expect(first.status, `first retry ${first.body}`).toBe(201);
      expect(first.headers.get("idempotent-replayed")).toBeNull();
      const stored = await recordRows(route, key);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.attempts).toBe(1);
      expect(stored[0]?.body).toBe(first.body);
      const replay = await send(survivor, route, key);
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      expect(replay.body).toBe(first.body);
    }
    const seen = await counts(key);
    expect(seen.executions).toBe(1);
    expect(seen.orders).toBe(mode === "lease" ? 1 : 0);
    return { ...seen, conflicts };
  } finally {
    await kill(survivor);
  }
}

for (const mode of MODES) {
  describe(`crash group, ${mode} mode`, () => {
    for (const point of POINTS) {
      it(
        `killed at ${point}: ${ROUNDS} round(s)`,
        async () => {
          const observed: RoundStats[] = [];
          for (let i = 0; i < ROUNDS; i += 1) {
            observed.push(await round(mode, point));
          }
          stats.set(`${mode} ${point}`, observed);
        },
        30_000 + ROUNDS * 15_000,
      );
    }
  });
}
