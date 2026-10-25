import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * One event the child server reported, on stdout or over IPC; see child-server.mjs for the
 * shapes.
 */
export interface ChildEvent {
  event: string;
  [field: string]: unknown;
}

export interface ChildServerOptions {
  databaseUrl: string;
  schema: string;
  secret: string;
  /** Path and route template the child serves, for example `/stall`. */
  route: string;
  lease?: string;
  mode?: "lease" | "transactional";
  /** The child's handler; see child-server.mjs. Default `"until-abort"`. */
  handler?: "until-abort" | "crash";
  /** Crash handler only: where the child stops and waits to be killed. */
  killAt?: "P1" | "P2" | "P3" | "P4";
}

/**
 * A child-server.mjs process: an idemfence/fetch server the test can freeze (`stop`),
 * resume (`resume`) or kill. Waits are on the events it reports, each with a deadline.
 */
export interface ChildServer {
  readonly url: string;
  readonly events: readonly ChildEvent[];
  /** Resolves with the first event (already seen or future) that `match` accepts. */
  waitFor(
    match: (event: ChildEvent) => boolean,
    deadlineMs?: number,
  ): Promise<ChildEvent>;
  /** SIGSTOP: the process is frozen, timers included, until `resume`. */
  stop(): void;
  /** SIGCONT. */
  resume(): void;
  /**
   * Sends `signal` (default SIGKILL, which ends even a frozen process without letting it run
   * again) and resolves once the process has exited.
   */
  kill(signal?: NodeJS.Signals): Promise<void>;
}

const SCRIPT = fileURLToPath(new URL("./child-server.mjs", import.meta.url));

/** Starts a child server and resolves once it is listening. */
export async function startChildServer(
  options: ChildServerOptions,
): Promise<ChildServer> {
  const child: ChildProcess = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      CHILD_DATABASE_URL: options.databaseUrl,
      CHILD_SCHEMA: options.schema,
      CHILD_SECRET: options.secret,
      CHILD_ROUTE: options.route,
      CHILD_LEASE: options.lease ?? "30s",
      CHILD_MODE: options.mode ?? "lease",
      CHILD_HANDLER: options.handler ?? "until-abort",
      ...(options.killAt === undefined
        ? {}
        : { CHILD_KILL_AT: options.killAt }),
    },
    stdio: ["ignore", "pipe", "inherit", "ipc"],
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  const events: ChildEvent[] = [];
  const waiters = new Set<{
    match: (event: ChildEvent) => boolean;
    resolve: (event: ChildEvent) => void;
  }>();
  if (child.stdout === null) {
    throw new Error("child stdout is not piped");
  }
  const record = (event: ChildEvent) => {
    events.push(event);
    for (const waiter of waiters) {
      if (waiter.match(event)) {
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event: ChildEvent;
    try {
      event = { ...(JSON.parse(line) as ChildEvent), via: "stdout" };
    } catch {
      event = { event: "stdout", line };
    }
    record(event);
  });
  // Kill points arrive over IPC as well, so a test can act on them without parsing output.
  child.on("message", (message) => {
    record({ ...(message as ChildEvent), via: "ipc" });
  });

  const waitFor = (
    match: (event: ChildEvent) => boolean,
    deadlineMs = 10_000,
  ): Promise<ChildEvent> => {
    const seen = events.find(match);
    if (seen !== undefined) {
      return Promise.resolve(seen);
    }
    return new Promise<ChildEvent>((resolve, reject) => {
      const waiter = {
        match,
        resolve: (event: ChildEvent) => {
          clearTimeout(timer);
          resolve(event);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(
          new Error(
            `child event not seen within ${deadlineMs} ms; saw ${JSON.stringify(events)}`,
          ),
        );
      }, deadlineMs);
      waiters.add(waiter);
    });
  };

  const listening = await waitFor((event) => event.event === "listening");
  return {
    url: `http://127.0.0.1:${String(listening.port)}`,
    events,
    waitFor,
    stop: () => {
      child.kill("SIGSTOP");
    },
    resume: () => {
      child.kill("SIGCONT");
    },
    kill: async (signal = "SIGKILL") => {
      if (child.exitCode === null && child.signalCode === null) {
        // SIGKILL ends even a stopped process without letting it run again; any other
        // signal stays pending on a stopped process until it is continued.
        if (signal !== "SIGKILL") {
          child.kill("SIGCONT");
        }
        child.kill(signal);
      }
      await exited;
    },
  };
}
