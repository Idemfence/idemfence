// The Crash group against small stub targets: a conforming one passes, and each broken one
// fails on its own message. The stub runs in this process; its crash.kill and crash.start
// commands are real argv (a node one-liner that POSTs to the stub's control endpoints), run
// by the suite with execFile like any target's.
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  CRASH_EARLY_SLACK_MS,
  type CrashResult,
  runCrashGroup,
  validateConfig,
} from "../src/index.js";

type Fault =
  /** Honours the lease (lease mode) or rolls back the killed attempt (transactional). */
  | "none"
  /** Lease mode: forgets the killed attempt, so the first retry runs again at once. */
  | "forget-on-kill"
  /** Lease mode: frees the key after half the lease. */
  | "half-lease"
  /** Takes `restartDelayMs` after crash.start to be ready. */
  | "slow-restart"
  /** Transactional mode: keeps the killed attempt in flight, so the first retry gets 409. */
  | "keep-in-flight";

interface Stub {
  url: string;
  close(): Promise<void>;
}

const WORK_MS = 1_500;
const DOCS = "https://example.com/docs/idempotency";

/** A target with an idempotent POST /crash, GET /count, GET /healthz and the controls. */
async function startStub(
  mode: "lease" | "transactional",
  leaseMs: number,
  fault: Fault,
  restartDelayMs = 0,
): Promise<Stub> {
  interface Entry {
    leaseUntil: number;
    body?: Buffer;
    generation: number;
  }
  const entries = new Map<string, Entry>();
  let count = 0;
  let down = false;
  let generation = 0;
  const sockets = new Set<Socket>();
  const working = new Set<{ socket: Socket; key: string }>();

  const json = (
    response: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const bytes = Buffer.from(JSON.stringify(body));
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(bytes.length),
      ...headers,
    });
    response.end(bytes);
  };

  const server = http.createServer((request, response) => {
    const path = request.url ?? "/";
    if (request.method === "POST" && path === "/__kill") {
      down = true;
      generation += 1;
      for (const job of working) {
        job.socket.destroy();
        const entry = entries.get(job.key);
        if (entry === undefined || entry.body !== undefined) {
          continue;
        }
        if (mode === "transactional" && fault !== "keep-in-flight") {
          // The killed transaction rolls back: no record, no side effect.
          entries.delete(job.key);
          count -= 1;
        } else if (fault === "forget-on-kill") {
          entries.delete(job.key);
        }
      }
      working.clear();
      json(response, 200, { killed: true });
      return;
    }
    if (request.method === "POST" && path === "/__start") {
      if (fault === "slow-restart") {
        setTimeout(() => {
          down = false;
        }, restartDelayMs);
      } else {
        down = false;
      }
      json(response, 200, { started: true });
      return;
    }
    if (down) {
      // A dead process accepts nothing.
      request.socket.destroy();
      return;
    }
    if (request.method === "GET" && path === "/healthz") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && path === "/count") {
      json(response, 200, { count });
      return;
    }
    if (request.method === "POST" && path === "/crash") {
      request.resume();
      const key = String(request.headers["idempotency-key"] ?? "");
      const entry = entries.get(key);
      const now = Date.now();
      if (entry?.body !== undefined) {
        response.writeHead(201, {
          "content-type": "application/json",
          "content-length": String(entry.body.length),
          "idempotent-replayed": "true",
        });
        response.end(entry.body);
        return;
      }
      if (entry !== undefined && now < entry.leaseUntil) {
        const type = `${DOCS}#in-flight`;
        const bytes = Buffer.from(
          JSON.stringify({
            type,
            title: "A request is outstanding for this Idempotency-Key",
            status: 409,
            detail: "in flight",
          }),
        );
        response.writeHead(409, {
          "content-type": "application/problem+json",
          "content-length": String(bytes.length),
          link: `<${type}>; rel="describedby"`,
          "retry-after": String(
            Math.max(1, Math.ceil((entry.leaseUntil - now) / 1000)),
          ),
        });
        response.end(bytes);
        return;
      }
      // A fresh attempt: the side effect at once, then the work.
      count += 1;
      const mine = generation;
      entries.set(key, {
        leaseUntil: now + (fault === "half-lease" ? leaseMs / 2 : leaseMs),
        generation: mine,
      });
      const job = { socket: request.socket, key };
      working.add(job);
      setTimeout(() => {
        working.delete(job);
        if (generation !== mine) {
          return;
        }
        const body = Buffer.from(JSON.stringify({ n: count }));
        const current = entries.get(key);
        if (current !== undefined) {
          current.body = body;
        }
        response.writeHead(201, {
          "content-type": "application/json",
          "content-length": String(body.length),
        });
        response.end(body);
      }, WORK_MS);
      return;
    }
    json(response, 404, { error: "not found" });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

/** argv that POSTs to `url` and exits 0 on a 2xx, like a real kill or start command. */
const post = (url: string): string[] => [
  process.execPath,
  "-e",
  "fetch(process.argv[1], { method: 'POST' }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))",
  url,
];

const stubs: Stub[] = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
});

async function crashAgainst(
  mode: "lease" | "transactional",
  fault: Fault,
  { leaseMs = 3_000, restartDelayMs = 0 } = {},
): Promise<CrashResult> {
  const stub = await startStub(mode, leaseMs, fault, restartDelayMs);
  stubs.push(stub);
  const config = validateConfig({
    acknowledgeSideEffects: true,
    keyMaxLength: 255,
    requestBodyCap: 1024,
    mode,
    fixtures: {
      crash: { method: "POST", path: "/crash", body: { item: "crash" } },
      count: { path: "/count" },
    },
    crash: {
      kill: post(`${stub.url}/__kill`),
      start: post(`${stub.url}/__start`),
      readyPath: "/healthz",
      ...(mode === "lease" ? { leaseMs } : {}),
    },
  });
  return runCrashGroup(stub.url, config);
}

describe("Crash group, lease mode", () => {
  it("passes a target that honours the killed attempt's lease", async () => {
    const result = await crashAgainst("lease", "none");
    expect(result.messages).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.conflicts).toBeGreaterThan(0);
    expect(result.firstSuccessMs).toBeGreaterThanOrEqual(
      3_000 - CRASH_EARLY_SLACK_MS,
    );
  }, 20_000);

  it("fails a target that runs the request again on the first retry after the restart (b)", async () => {
    const result = await crashAgainst("lease", "forget-on-kill");
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(0);
    expect(result.messages).toContain(
      "no 409 before the first success: the target ran the request again at once instead of honouring the killed attempt's lease",
    );
  }, 20_000);

  it("fails a target that frees the key at half the lease (c)", async () => {
    const result = await crashAgainst("lease", "half-lease");
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBeGreaterThan(0);
    expect(result.messages).toEqual([
      expect.stringMatching(
        /^the first retry answered otherwise was sent \d+ ms after the crash request, before lease - 1000 ms = 2000 ms: the target freed the key before the killed attempt's lease expired$/,
      ),
    ]);
  }, 20_000);

  it("fails, and does not pass silently, when the restart outlasts the lease (a)", async () => {
    const result = await crashAgainst("lease", "slow-restart", {
      restartDelayMs: 3_000,
    });
    expect(result.ok).toBe(false);
    expect(result.messages).toEqual([
      expect.stringMatching(
        /^the target was ready again \d+ ms after the crash request \(\d+ ms after the kill\), not before lease - 1000 ms = 2000 ms, so the lease window cannot be observed: the lease must be longer, at least \d+ ms here$/,
      ),
    ]);
  }, 20_000);
});

describe("Crash group, transactional mode", () => {
  it("passes a target that rolls the killed attempt back", async () => {
    const result = await crashAgainst("transactional", "none");
    expect(result.messages).toEqual([]);
    expect(result.ok).toBe(true);
  }, 20_000);

  it("fails a target that answers the first retry after the restart with a 409", async () => {
    const result = await crashAgainst("transactional", "keep-in-flight");
    expect(result.ok).toBe(false);
    expect(result.messages).toContain(
      "the first retry after the restart should succeed (the killed transaction rolled back), got 409",
    );
  }, 20_000);
});
