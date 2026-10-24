import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------------------
// Target configuration
// ---------------------------------------------------------------------------------------

/** A request the target accepts; `body` is sent as JSON when present. */
export interface Fixture {
  method: string;
  path: string;
  body?: unknown;
}

export interface TargetConfig {
  /** Headers sent on every request, for example a principal or an auth header. */
  headers: Record<string, string>;
  keyMaxLength: number;
  requestBodyCap: number;
  keySyntax: "sf-string" | "sf-string-or-raw";
  fixtures: {
    /** A normal idempotent POST; `alternateBody` is a different payload for row 7. */
    create?: Fixture & { alternateBody: unknown };
    /** GET → `{ "count": n }`: the number of side effects so far. */
    count?: { path: string };
    /** An idempotent request whose handler takes about `workMs` milliseconds. */
    slow?: Fixture & { workMs: number };
    /** An idempotent request answered with the configured release status. */
    release?: Fixture & { status: number };
    /** An idempotent request whose handler throws. */
    throws?: Fixture;
    /** An idempotent request on a route whose retention is `retentionMs`. */
    shortRetention?: Fixture & { retentionMs: number };
    /** A request on a route or method the target does not make idempotent. */
    passthrough?: Fixture;
    /** How to send a request without a principal: headers to leave out. */
    noPrincipal?: { omitHeaders: string[] };
  };
}

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`invalid target config:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

const METHOD = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Validates a parsed JSON config; throws {@link ConfigError} listing every problem. */
export function validateConfig(value: unknown): TargetConfig {
  const problems: string[] = [];
  const object = isRecord(value) ? value : {};
  if (!isRecord(value)) {
    problems.push("config must be a JSON object");
  }

  const headers: Record<string, string> = {};
  if (object.headers !== undefined) {
    if (!isRecord(object.headers)) {
      problems.push(
        "headers must be an object of header names to string values",
      );
    } else {
      for (const [name, header] of Object.entries(object.headers)) {
        if (typeof header !== "string") {
          problems.push(`headers.${name} must be a string`);
        } else {
          headers[name] = header;
        }
      }
    }
  }

  const keyMaxLength = object.keyMaxLength;
  if (
    !Number.isInteger(keyMaxLength) ||
    (keyMaxLength as number) < 1 ||
    (keyMaxLength as number) > 255
  ) {
    problems.push("keyMaxLength must be an integer from 1 to 255");
  }
  const requestBodyCap = object.requestBodyCap;
  if (!Number.isInteger(requestBodyCap) || (requestBodyCap as number) < 1) {
    problems.push("requestBodyCap must be a positive integer (bytes)");
  }
  const keySyntax = object.keySyntax ?? "sf-string";
  if (keySyntax !== "sf-string" && keySyntax !== "sf-string-or-raw") {
    problems.push('keySyntax must be "sf-string" or "sf-string-or-raw"');
  }

  const fixtures: TargetConfig["fixtures"] = {};
  const rawFixtures = object.fixtures ?? {};
  if (!isRecord(rawFixtures)) {
    problems.push("fixtures must be an object");
  } else {
    const fixture = (
      name: string,
      extra: (f: Record<string, unknown>) => void = () => {},
    ): Record<string, unknown> | undefined => {
      const raw = rawFixtures[name];
      if (raw === undefined) {
        return undefined;
      }
      if (!isRecord(raw)) {
        problems.push(`fixtures.${name} must be an object`);
        return undefined;
      }
      if (typeof raw.method !== "string" || !METHOD.test(raw.method)) {
        problems.push(`fixtures.${name}.method must be an HTTP method token`);
      }
      if (typeof raw.path !== "string" || !raw.path.startsWith("/")) {
        problems.push(`fixtures.${name}.path must start with /`);
      }
      extra(raw);
      return raw;
    };
    const base = (raw: Record<string, unknown>): Fixture => ({
      method: String(raw.method),
      path: String(raw.path),
      ...(raw.body === undefined ? {} : { body: raw.body }),
    });
    const create = fixture("create", (f) => {
      if (f.alternateBody === undefined) {
        problems.push(
          "fixtures.create.alternateBody is required (a different payload for row 7)",
        );
      }
    });
    if (create !== undefined) {
      fixtures.create = {
        ...base(create),
        alternateBody: create.alternateBody,
      };
    }
    const count = rawFixtures.count;
    if (count !== undefined) {
      if (
        !isRecord(count) ||
        typeof count.path !== "string" ||
        !count.path.startsWith("/")
      ) {
        problems.push("fixtures.count.path must start with /");
      } else {
        fixtures.count = { path: count.path };
      }
    }
    const slow = fixture("slow", (f) => {
      if (!Number.isInteger(f.workMs) || (f.workMs as number) < 500) {
        problems.push(
          "fixtures.slow.workMs must be an integer of at least 500 (milliseconds)",
        );
      }
    });
    if (slow !== undefined) {
      fixtures.slow = { ...base(slow), workMs: Number(slow.workMs) };
    }
    const release = fixture("release", (f) => {
      if (
        !Number.isInteger(f.status) ||
        (f.status as number) < 400 ||
        (f.status as number) > 599
      ) {
        problems.push(
          "fixtures.release.status must be an integer status from 400 to 599",
        );
      }
    });
    if (release !== undefined) {
      fixtures.release = { ...base(release), status: Number(release.status) };
    }
    const throws = fixture("throws");
    if (throws !== undefined) {
      fixtures.throws = base(throws);
    }
    const shortRetention = fixture("shortRetention", (f) => {
      if (!Number.isInteger(f.retentionMs) || (f.retentionMs as number) < 100) {
        problems.push(
          "fixtures.shortRetention.retentionMs must be an integer of at least 100 (milliseconds)",
        );
      }
    });
    if (shortRetention !== undefined) {
      fixtures.shortRetention = {
        ...base(shortRetention),
        retentionMs: Number(shortRetention.retentionMs),
      };
    }
    const passthrough = fixture("passthrough");
    if (passthrough !== undefined) {
      fixtures.passthrough = base(passthrough);
    }
    const noPrincipal = rawFixtures.noPrincipal;
    if (noPrincipal !== undefined) {
      if (
        !isRecord(noPrincipal) ||
        !Array.isArray(noPrincipal.omitHeaders) ||
        noPrincipal.omitHeaders.length === 0 ||
        !noPrincipal.omitHeaders.every((h) => typeof h === "string")
      ) {
        problems.push(
          "fixtures.noPrincipal.omitHeaders must be a non-empty array of header names",
        );
      } else {
        fixtures.noPrincipal = {
          omitHeaders: noPrincipal.omitHeaders as string[],
        };
      }
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return {
    headers,
    keyMaxLength: keyMaxLength as number,
    requestBodyCap: requestBodyCap as number,
    keySyntax: keySyntax as TargetConfig["keySyntax"],
    fixtures,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------

export interface CliOptions {
  url: string;
  config: string;
  json: boolean;
  requireAll: boolean;
  only: number[] | undefined;
}

export const USAGE = `Usage: idemfence-conformance --url <base-url> --config <target.json> [options]

Runs the Contract group of the idemfence conformance suite against an HTTP target.

Options:
  --url <base-url>      Base URL of the target, for example http://127.0.0.1:3000
  --config <file.json>  Target configuration (see the package README)
  --json                Machine-readable output
  --require-all         Treat scenarios that were not run (missing fixtures) as failures
  --only <rows>         Comma-separated row numbers to run, for example 5,6,7
  --help                Show this help

Exit status is 0 only when no scenario failed (and, with --require-all, none was not run).
`;

/** Parses CLI arguments; throws an Error with a message for invalid input. */
export function parseCliArgs(
  argv: readonly string[],
): CliOptions | { help: true } {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      url: { type: "string" },
      config: { type: "string" },
      json: { type: "boolean", default: false },
      "require-all": { type: "boolean", default: false },
      only: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    return { help: true };
  }
  const problems: string[] = [];
  if (values.url === undefined || values.url === "") {
    problems.push("--url is required");
  } else {
    try {
      const parsed = new URL(values.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        problems.push("--url must be an http:// or https:// URL");
      }
    } catch {
      problems.push("--url must be a valid URL");
    }
  }
  if (values.config === undefined || values.config === "") {
    problems.push("--config is required");
  }
  let only: number[] | undefined;
  if (values.only !== undefined) {
    only = values.only.split(",").map((part) => Number(part.trim()));
    if (
      only.length === 0 ||
      only.some((row) => !Number.isInteger(row) || row < 1 || row > 16)
    ) {
      problems.push(
        "--only must be a comma-separated list of row numbers from 1 to 16",
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(problems.join("; "));
  }
  return {
    url: values.url as string,
    config: values.config as string,
    json: values.json,
    requireAll: values["require-all"],
    only,
  };
}

// ---------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: Buffer;
}

interface SendOptions {
  key?: string | string[] | undefined;
  rawKey?: string | undefined;
  omitHeaders?: readonly string[] | undefined;
  body?: Buffer | undefined;
  /** Destroy the connection this many milliseconds after the request was sent (row 16). */
  abortAfterMs?: number | undefined;
}

class Client {
  constructor(
    private readonly base: URL,
    private readonly headers: Record<string, string>,
  ) {}

  async send(fixture: Fixture, options: SendOptions = {}): Promise<Reply> {
    const url = new URL(fixture.path, this.base);
    const headers: http.OutgoingHttpHeaders = {};
    const omitted = new Set(
      (options.omitHeaders ?? []).map((name) => name.toLowerCase()),
    );
    for (const [name, value] of Object.entries(this.headers)) {
      if (!omitted.has(name.toLowerCase())) {
        headers[name] = value;
      }
    }
    const body =
      options.body ??
      (fixture.body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(fixture.body)));
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(body.byteLength);
    }
    if (options.rawKey !== undefined) {
      headers["idempotency-key"] = options.rawKey;
    } else if (Array.isArray(options.key)) {
      headers["idempotency-key"] = options.key.map((k) => `"${k}"`);
    } else if (options.key !== undefined) {
      headers["idempotency-key"] = `"${options.key}"`;
    }

    const transport = url.protocol === "https:" ? https : http;
    return new Promise<Reply>((resolve, reject) => {
      const request = transport.request(url, {
        method: fixture.method,
        headers,
      });
      let settled = false;
      const chunks: Buffer[] = [];
      request.on("response", (response) => {
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
          });
        });
        response.on("error", (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      });
      request.on("error", (error) => {
        // A write error after the response arrived (the server closed early) is expected
        // for an oversized upload; the response already settled this promise.
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      if (body !== undefined) {
        request.write(body);
      }
      if (options.abortAfterMs !== undefined) {
        // Keep the request open, then tear the connection down mid-request.
        request.flushHeaders();
        setTimeout(() => {
          if (!settled) {
            settled = true;
            request.destroy();
            resolve({ status: 0, headers: {}, bytes: Buffer.alloc(0) });
          }
        }, options.abortAfterMs);
        return;
      }
      request.end();
    });
  }
}

// ---------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------

export type Outcome = "pass" | "fail" | "not_run" | "not_testable" | "skipped";

export interface RowResult {
  row: string;
  title: string;
  outcome: Outcome;
  messages: string[];
  durationMs: number;
}

class Check {
  readonly messages: string[] = [];
  private failed = false;

  that(condition: boolean, message: string): boolean {
    if (!condition) {
      this.failed = true;
      this.messages.push(message);
    }
    return condition;
  }

  note(message: string): void {
    this.messages.push(message);
  }

  get outcome(): Outcome {
    return this.failed ? "fail" : "pass";
  }
}

class NotRun extends Error {}

interface Context {
  client: Client;
  config: TargetConfig;
  count(): Promise<number>;
  fixture<K extends keyof TargetConfig["fixtures"]>(
    name: K,
  ): NonNullable<TargetConfig["fixtures"][K]>;
  /** Shared between rows 5 and 6. */
  first?: { key: string; reply: Reply; countAfter: number };
}

const newKey = (row: string): string =>
  `conformance-${row}-${randomBytes(6).toString("hex")}`;

function problem(
  check: Check,
  reply: Reply,
  status: number,
  anchor: string | "about:blank",
): void {
  check.that(
    reply.status === status,
    `expected status ${status}, got ${reply.status}`,
  );
  const contentType = String(reply.headers["content-type"] ?? "");
  if (
    !check.that(
      contentType.startsWith("application/problem+json"),
      `expected application/problem+json, got ${contentType || "no content-type"}`,
    )
  ) {
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(reply.bytes.toString("utf8"));
  } catch {
    check.that(false, "problem body is not valid JSON");
    return;
  }
  const record = isRecord(body) ? body : {};
  check.that(
    record.status === status,
    `problem body status should be ${status}, got ${String(record.status)}`,
  );
  check.that(
    typeof record.title === "string" && record.title !== "",
    "problem body must have a title",
  );
  const type = String(record.type ?? "");
  if (anchor === "about:blank") {
    check.that(
      type === "about:blank",
      `problem type should be about:blank, got ${type}`,
    );
    check.that(
      reply.headers.link === undefined,
      "an about:blank problem must not carry a Link header",
    );
  } else {
    check.that(
      type.endsWith(`#${anchor}`),
      `problem type should end with #${anchor}, got ${type}`,
    );
    const link = String(reply.headers.link ?? "");
    check.that(
      link.includes(`<${type}>`) && /rel="describedby"/.test(link),
      `Link header should be <${type}>; rel="describedby", got ${link || "none"}`,
    );
  }
}

const replayed = (reply: Reply): boolean =>
  String(reply.headers["idempotent-replayed"] ?? "") === "true";

type Scenario = (ctx: Context, check: Check) => Promise<void>;

const scenarios: {
  row: string;
  title: string;
  scenario: Scenario | { notTestable: string };
}[] = [
  {
    row: "1",
    title: "an unconfigured route or method ignores the key",
    scenario: async (ctx, check) => {
      const fixture = ctx.fixture("passthrough");
      const key = newKey("1");
      const first = await ctx.client.send(fixture, { key });
      const second = await ctx.client.send(fixture, { key });
      check.that(
        first.status < 400,
        `first request should not be rejected, got ${first.status}`,
      );
      check.that(
        second.status === first.status,
        `second request should get the same status (${first.status}), got ${second.status}`,
      );
      check.that(
        !replayed(first) && !replayed(second),
        "a passthrough response must not carry Idempotent-Replayed",
      );
    },
  },
  {
    row: "2",
    title: "a required key that is missing is a 400 key-missing",
    scenario: async (ctx, check) => {
      const before = await ctx.count();
      const reply = await ctx.client.send(ctx.fixture("create"));
      problem(check, reply, 400, "key-missing");
      check.that(
        (await ctx.count()) === before,
        "no side effect may happen without a key",
      );
    },
  },
  {
    row: "3",
    title: "malformed keys are a 400 key-malformed",
    scenario: async (ctx, check) => {
      const fixture = ctx.fixture("create");
      const cases: [string, SendOptions][] = [
        ["unterminated quote", { rawKey: '"abc' }],
        ["invalid escape", { rawKey: '"a\\nb"' }],
        ["empty string", { rawKey: '""' }],
        [
          "over keyMaxLength",
          { rawKey: `"${"x".repeat(ctx.config.keyMaxLength + 1)}"` },
        ],
        ["two keys (comma-joined)", { key: ["a", "b"] }],
        ["integer item", { rawKey: "42" }],
      ];
      if (ctx.config.keySyntax === "sf-string") {
        cases.push([
          "unquoted token",
          { rawKey: `abc-${randomBytes(4).toString("hex")}` },
        ]);
      }
      const before = await ctx.count();
      for (const [name, options] of cases) {
        const reply = await ctx.client.send(fixture, options);
        const sub = new Check();
        problem(sub, reply, 400, "key-malformed");
        for (const message of sub.messages) {
          check.that(false, `${name}: ${message}`);
        }
      }
      check.that(
        (await ctx.count()) === before,
        "no side effect may happen for a malformed key",
      );
    },
  },
  {
    row: "4",
    title: "no principal is a 500 configuration-error",
    scenario: async (ctx, check) => {
      const { omitHeaders } = ctx.fixture("noPrincipal");
      const before = await ctx.count();
      const reply = await ctx.client.send(ctx.fixture("create"), {
        key: newKey("4"),
        omitHeaders,
      });
      problem(check, reply, 500, "configuration-error");
      check.that(
        (await ctx.count()) === before,
        "no side effect may happen without a principal",
      );
    },
  },
  {
    row: "5",
    title: "the first request runs the handler once",
    scenario: async (ctx, check) => {
      const before = await ctx.count();
      const key = newKey("5");
      const reply = await ctx.client.send(ctx.fixture("create"), { key });
      check.that(
        reply.status >= 200 && reply.status < 300,
        `expected a 2xx, got ${reply.status}`,
      );
      check.that(
        !replayed(reply),
        "the first response must not carry Idempotent-Replayed",
      );
      const after = await ctx.count();
      check.that(
        after === before + 1,
        `expected exactly one side effect, count went from ${before} to ${after}`,
      );
      ctx.first = { key, reply, countAfter: after };
    },
  },
  {
    row: "6",
    title:
      "the same request again is a byte-identical replay with no new side effect",
    scenario: async (ctx, check) => {
      if (ctx.first === undefined) {
        throw new NotRun("row 5 did not pass");
      }
      const { key, reply: first, countAfter } = ctx.first;
      const replay = await ctx.client.send(ctx.fixture("create"), { key });
      check.that(
        replay.status === first.status,
        `replay status should be ${first.status}, got ${replay.status}`,
      );
      check.that(
        replayed(replay),
        "replay must carry Idempotent-Replayed: true",
      );
      check.that(
        replay.bytes.equals(first.bytes),
        "replay body must be byte-identical to the first response",
      );
      const after = await ctx.count();
      check.that(
        after === countAfter,
        `duplicate side effect: count went from ${countAfter} to ${after} on a replay`,
      );
    },
  },
  {
    row: "7",
    title: "the same key with a different body is a 422 key-reused",
    scenario: async (ctx, check) => {
      const fixture = ctx.fixture("create");
      const key = newKey("7");
      const first = await ctx.client.send(fixture, { key });
      check.that(
        first.status >= 200 && first.status < 300,
        `first request: expected a 2xx, got ${first.status}`,
      );
      const before = await ctx.count();
      const reply = await ctx.client.send(
        { ...fixture, body: fixture.alternateBody },
        { key },
      );
      problem(check, reply, 422, "key-reused");
      check.that(
        (await ctx.count()) === before,
        "a reused key must not cause a side effect",
      );
    },
  },
  {
    row: "8",
    title:
      "a request while the first is in flight is a 409 with an integer Retry-After",
    scenario: async (ctx, check) => {
      const fixture = ctx.fixture("slow");
      const key = newKey("8");
      const before = await ctx.count();
      const inFlight = ctx.client.send(fixture, { key });
      await sleep(Math.min(500, Math.floor(fixture.workMs / 3)));
      const reply = await ctx.client.send(fixture, { key });
      problem(check, reply, 409, "in-flight");
      const retryAfter = String(reply.headers["retry-after"] ?? "");
      check.that(
        /^[1-9]\d*$/.test(retryAfter),
        `Retry-After should be a positive integer, got ${retryAfter || "none"}`,
      );
      const first = await inFlight;
      check.that(
        first.status >= 200 && first.status < 300,
        `the in-flight request should complete with a 2xx, got ${first.status}`,
      );
      const after = await ctx.count();
      check.that(
        after === before + 1,
        `expected exactly one side effect, count went from ${before} to ${after}`,
      );
    },
  },
  {
    row: "9",
    title: "takeover of an expired lease",
    scenario: {
      notTestable: "not testable black-box here (covered by step 2.5)",
    },
  },
  {
    row: "10",
    title: "a key past retention is treated as a first request",
    scenario: async (ctx, check) => {
      const fixture = ctx.fixture("shortRetention");
      const key = newKey("10");
      const before = await ctx.count();
      const first = await ctx.client.send(fixture, { key });
      check.that(
        first.status >= 200 && first.status < 300,
        `first request: expected a 2xx, got ${first.status}`,
      );
      await sleep(fixture.retentionMs + 600);
      const again = await ctx.client.send(fixture, { key });
      check.that(
        again.status >= 200 && again.status < 300,
        `after retention: expected a 2xx, got ${again.status}`,
      );
      check.that(
        !replayed(again),
        "after retention the request must be re-executed, not replayed",
      );
      const after = await ctx.count();
      check.that(
        after === before + 2,
        `expected two side effects, count went from ${before} to ${after}`,
      );
    },
  },
  {
    row: "11",
    title: "a release status is returned as-is and the key stays reusable",
    scenario: async (ctx, check) => {
      const fixture = ctx.fixture("release");
      const key = newKey("11");
      const first = await ctx.client.send(fixture, { key });
      check.that(
        first.status === fixture.status,
        `expected the release status ${fixture.status}, got ${first.status}`,
      );
      check.that(
        !replayed(first),
        "a released response must not carry Idempotent-Replayed",
      );
      const second = await ctx.client.send(fixture, { key });
      check.that(
        second.status === fixture.status,
        `retry: expected the handler to run again (${fixture.status}), got ${second.status}`,
      );
      check.that(
        !replayed(second),
        "the retry must be a fresh execution, not a replay",
      );
    },
  },
  {
    row: "12",
    title: "a thrown error is a stored 500 about:blank problem that replays",
    scenario: async (ctx, check) => {
      const fixture = ctx.fixture("throws");
      const key = newKey("12");
      const before = await ctx.count();
      const first = await ctx.client.send(fixture, { key });
      problem(check, first, 500, "about:blank");
      const second = await ctx.client.send(fixture, { key });
      check.that(
        second.status === 500,
        `retry: expected the stored 500, got ${second.status}`,
      );
      check.that(
        replayed(second),
        "the retry must be a replay (Idempotent-Replayed: true)",
      );
      check.that(
        second.bytes.equals(first.bytes),
        "the replayed 500 must be byte-identical",
      );
      check.that(
        (await ctx.count()) === before,
        "the handler must not run again after a stored failure",
      );
    },
  },
  {
    row: "13",
    title: "a throw in transactional mode rolls back",
    scenario: {
      notTestable: "not testable black-box here (covered by step 2.2)",
    },
  },
  {
    row: "14",
    title: "store unavailable",
    scenario: {
      notTestable: "not testable black-box here (covered by step 2.6)",
    },
  },
  {
    row: "15",
    title: "a body over the request cap is a 413 body-too-large",
    scenario: async (ctx, check) => {
      const fixture = ctx.fixture("create");
      const before = await ctx.count();
      const padding = ctx.config.requestBodyCap + 1 - '{"item":""}'.length;
      const body = Buffer.from(
        `{"item":"${"x".repeat(Math.max(1, padding))}"}`,
      );
      const reply = await ctx.client.send(fixture, { key: newKey("15"), body });
      problem(check, reply, 413, "body-too-large");
      const connection = reply.headers.connection;
      if (connection === undefined) {
        check.note(
          "Connection header absent (expected over HTTP/2; HTTP/1.1 targets must send Connection: close)",
        );
      } else {
        check.that(
          String(connection).toLowerCase() === "close",
          `Connection header should be close, got ${String(connection)}`,
        );
      }
      check.that(
        (await ctx.count()) === before,
        "no side effect may happen for an oversized body",
      );
    },
  },
  {
    row: "16",
    title: "a client disconnect does not abort the handler; a retry replays",
    scenario: async (ctx, check) => {
      const fixture = ctx.fixture("slow");
      const key = newKey("16");
      const before = await ctx.count();
      await ctx.client.send(fixture, {
        key,
        abortAfterMs: Math.min(500, Math.floor(fixture.workMs / 3)),
      });
      await sleep(fixture.workMs + 1_000);
      const retry = await ctx.client.send(fixture, { key });
      check.that(
        retry.status >= 200 && retry.status < 300,
        `retry: expected the stored 2xx, got ${retry.status}`,
      );
      check.that(
        replayed(retry),
        "the retry must be a replay of the stored response",
      );
      const after = await ctx.count();
      check.that(
        after === before + 1,
        `expected exactly one side effect, count went from ${before} to ${after}`,
      );
    },
  },
];

export const NOT_TESTABLE_ROWS: readonly string[] = ["9", "13", "14"];

/** Runs the Contract group against `baseUrl` and returns one result per row. */
export async function runContractGroup(
  baseUrl: string,
  config: TargetConfig,
  options: { only?: number[] | undefined } = {},
): Promise<RowResult[]> {
  const base = new URL(baseUrl);
  const client = new Client(base, config.headers);
  const only =
    options.only === undefined ? undefined : new Set(options.only.map(String));
  const ctx: Context = {
    client,
    config,
    async count() {
      const fixture = this.fixture("count");
      const reply = await client.send({ method: "GET", path: fixture.path });
      const body = JSON.parse(reply.bytes.toString("utf8")) as {
        count?: unknown;
      };
      if (reply.status !== 200 || typeof body.count !== "number") {
        throw new Error(
          `count fixture ${fixture.path} returned ${reply.status} ${reply.bytes.toString("utf8").slice(0, 100)}`,
        );
      }
      return body.count;
    },
    fixture(name) {
      const fixture = config.fixtures[name];
      if (fixture === undefined) {
        throw new NotRun(`fixture ${name} missing`);
      }
      return fixture as NonNullable<TargetConfig["fixtures"][typeof name]>;
    },
  };

  const results: RowResult[] = [];
  for (const { row, title, scenario } of scenarios) {
    const startedAt = Date.now();
    if (only !== undefined && !only.has(row)) {
      results.push({
        row,
        title,
        outcome: "skipped",
        messages: ["skipped by --only"],
        durationMs: 0,
      });
      continue;
    }
    if (typeof scenario === "object") {
      results.push({
        row,
        title,
        outcome: "not_testable",
        messages: [scenario.notTestable],
        durationMs: 0,
      });
      continue;
    }
    const check = new Check();
    let outcome: Outcome;
    try {
      await scenario(ctx, check);
      outcome = check.outcome;
    } catch (error) {
      if (error instanceof NotRun) {
        outcome = "not_run";
        check.note(`not run: ${error.message}`);
      } else {
        outcome = "fail";
        check.note(
          `error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    results.push({
      row,
      title,
      outcome,
      messages: check.messages,
      durationMs: Date.now() - startedAt,
    });
  }
  return results;
}

export interface Summary {
  pass: number;
  fail: number;
  notRun: number;
  notTestable: number;
  skipped: number;
  ok: boolean;
}

export function summarize(
  results: readonly RowResult[],
  requireAll: boolean,
): Summary {
  const count = (outcome: Outcome) =>
    results.filter((r) => r.outcome === outcome).length;
  const summary = {
    pass: count("pass"),
    fail: count("fail"),
    notRun: count("not_run"),
    notTestable: count("not_testable"),
    skipped: count("skipped"),
  };
  return {
    ...summary,
    ok: summary.fail === 0 && (!requireAll || summary.notRun === 0),
  };
}

export function formatHuman(
  baseUrl: string,
  results: readonly RowResult[],
  summary: Summary,
): string {
  const label: Record<Outcome, string> = {
    pass: "pass",
    fail: "FAIL",
    not_run: "not run",
    not_testable: "not testable",
    skipped: "skipped",
  };
  const lines = [`idemfence conformance, Contract group, target ${baseUrl}`];
  for (const result of results) {
    lines.push(
      `  row ${result.row.padEnd(3)} ${label[result.outcome].padEnd(13)} ${result.title}`,
    );
    for (const message of result.messages) {
      lines.push(`      ${message}`);
    }
  }
  lines.push(
    `summary: ${summary.pass} passed, ${summary.fail} failed, ${summary.notRun} not run, ${summary.notTestable} not testable, ${summary.skipped} skipped: ${summary.ok ? "OK" : "NOT OK"}`,
  );
  return lines.join("\n");
}
