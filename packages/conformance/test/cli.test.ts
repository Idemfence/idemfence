import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  type BurstReply,
  ConfigError,
  classifyIteration,
  formatHuman,
  KEY_PREFIX,
  NOT_APPLICABLE_IN_TRANSACTIONAL_MODE,
  newKey,
  parseCliArgs,
  type RowResult,
  runContractGroup,
  runCrashGroup,
  SIDE_EFFECTS_MESSAGE,
  summarize,
  validateConfig,
} from "../src/index.js";

describe("parseCliArgs", () => {
  it("parses the full option set", () => {
    expect(
      parseCliArgs([
        "--url",
        "http://127.0.0.1:3000",
        "--config",
        "t.json",
        "--json",
        "--require-all",
        "--only",
        "5, 6,7",
      ]),
    ).toStrictEqual({
      url: "http://127.0.0.1:3000",
      config: "t.json",
      json: true,
      requireAll: true,
      only: [5, 6, 7],
      group: "contract",
      iterations: 1000,
      concurrency: 50,
    });
  });

  it("defaults the flags", () => {
    expect(
      parseCliArgs(["--url", "https://api.example.com", "--config", "t.json"]),
    ).toStrictEqual({
      url: "https://api.example.com",
      config: "t.json",
      json: false,
      requireAll: false,
      only: undefined,
      group: "contract",
      iterations: 1000,
      concurrency: 50,
    });
  });

  it("parses the concurrency group options", () => {
    const parsed = parseCliArgs([
      "--url",
      "http://x",
      "--config",
      "t.json",
      "--group",
      "concurrency",
      "--iterations",
      "20",
      "--concurrency",
      "8",
    ]);
    expect(parsed).toMatchObject({
      group: "concurrency",
      iterations: 20,
      concurrency: 8,
    });
  });

  it("parses the crash group", () => {
    expect(
      parseCliArgs([
        "--url",
        "http://x",
        "--config",
        "t.json",
        "--group",
        "crash",
      ]),
    ).toMatchObject({ group: "crash" });
  });

  it("returns help", () => {
    expect(parseCliArgs(["--help"])).toStrictEqual({ help: true });
  });

  it.each([
    [["--config", "t.json"], "--url is required"],
    [["--url", "http://x"], "--config is required"],
    [["--url", "ftp://x", "--config", "t.json"], "http:// or https://"],
    [["--url", "not a url", "--config", "t.json"], "valid URL"],
    [
      ["--url", "http://x", "--config", "t.json", "--only", "5,x"],
      "--only must be",
    ],
    [
      ["--url", "http://x", "--config", "t.json", "--only", "17"],
      "--only must be",
    ],
    [["--url", "http://x", "--config", "t.json", "--bogus"], "Unknown option"],
    [["--url", "http://x", "--config", "t.json", "extra"], "positional"],
    [
      ["--url", "http://x", "--config", "t.json", "--group", "stress"],
      "--group must be",
    ],
    [
      ["--url", "http://x", "--config", "t.json", "--iterations", "0"],
      "--iterations must be",
    ],
    [
      ["--url", "http://x", "--config", "t.json", "--concurrency", "1"],
      "--concurrency must be",
    ],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});

const minimal = {
  acknowledgeSideEffects: true,
  keyMaxLength: 255,
  requestBodyCap: 1024,
};

describe("validateConfig", () => {
  it("accepts a minimal config and applies defaults", () => {
    expect(validateConfig(minimal)).toStrictEqual({
      acknowledgeSideEffects: true,
      headers: {},
      keyMaxLength: 255,
      requestBodyCap: 1024,
      keySyntax: "sf-string",
      mode: "lease",
      fixtures: {},
    });
  });

  it("accepts the crash fixture and the crash commands", () => {
    const config = validateConfig({
      ...minimal,
      fixtures: { crash: { method: "POST", path: "/crash", body: { a: 1 } } },
      crash: {
        kill: ["docker", "compose", "kill", "-s", "SIGKILL", "app"],
        start: ["docker", "compose", "start", "app"],
        readyPath: "/healthz",
        leaseMs: 2000,
      },
    });
    expect(config.fixtures.crash).toStrictEqual({
      method: "POST",
      path: "/crash",
      body: { a: 1 },
    });
    expect(config.crash).toStrictEqual({
      kill: ["docker", "compose", "kill", "-s", "SIGKILL", "app"],
      start: ["docker", "compose", "start", "app"],
      readyPath: "/healthz",
      leaseMs: 2000,
    });
    expect("crash" in validateConfig(minimal)).toBe(false);
  });

  it.each([
    [
      { kill: "docker kill", start: ["a"], readyPath: "/r" },
      "crash.kill must be",
    ],
    [{ kill: ["a"], start: [], readyPath: "/r" }, "crash.start must be"],
    [{ kill: ["a", ""], start: ["b"], readyPath: "/r" }, "crash.kill must be"],
    [{ kill: ["a"], start: ["b"], readyPath: "r" }, "crash.readyPath must"],
    [
      { kill: ["a"], start: ["b"], readyPath: "/r", leaseMs: 0 },
      "crash.leaseMs must",
    ],
    ["kill it", "crash must be an object"],
  ])("rejects crash %j", (crash, message) => {
    expect(() => validateConfig({ ...minimal, crash })).toThrow(message);
  });

  it("accepts mode transactional", () => {
    expect(validateConfig({ ...minimal, mode: "transactional" }).mode).toBe(
      "transactional",
    );
  });

  it("accepts every fixture", () => {
    const config = validateConfig({
      ...minimal,
      headers: { "X-Principal": "p" },
      keySyntax: "sf-string-or-raw",
      fixtures: {
        create: {
          method: "POST",
          path: "/orders",
          body: { a: 1 },
          alternateBody: { a: 2 },
        },
        count: { path: "/orders/count" },
        slow: {
          method: "POST",
          path: "/orders",
          body: { simulateWorkMs: 1500 },
          workMs: 1500,
        },
        release: { method: "POST", path: "/release", status: 429 },
        throws: { method: "POST", path: "/throws" },
        shortRetention: { method: "POST", path: "/short", retentionMs: 1500 },
        passthrough: { method: "PUT", path: "/echo" },
        noPrincipal: { omitHeaders: ["X-Principal"] },
      },
    });
    expect(config.keySyntax).toBe("sf-string-or-raw");
    expect(Object.keys(config.fixtures).sort()).toStrictEqual([
      "count",
      "create",
      "noPrincipal",
      "passthrough",
      "release",
      "shortRetention",
      "slow",
      "throws",
    ]);
    expect(config.fixtures.release?.status).toBe(429);
  });

  it.each([
    [null, "config must be a JSON object"],
    [
      { keyMaxLength: 255, requestBodyCap: 1 },
      "acknowledgeSideEffects must be true",
    ],
    [
      { acknowledgeSideEffects: false, keyMaxLength: 255, requestBodyCap: 1 },
      "acknowledgeSideEffects must be true",
    ],
    [
      { acknowledgeSideEffects: "true", keyMaxLength: 255, requestBodyCap: 1 },
      "acknowledgeSideEffects must be true",
    ],
    [
      { acknowledgeSideEffects: true, requestBodyCap: 1 },
      "keyMaxLength must be",
    ],
    [{ keyMaxLength: 256, requestBodyCap: 1 }, "keyMaxLength must be"],
    [{ keyMaxLength: 255 }, "requestBodyCap must be"],
    [{ ...minimal, keySyntax: "raw" }, "keySyntax must be"],
    [{ ...minimal, mode: "tx" }, 'mode must be "lease" or "transactional"'],
    [{ ...minimal, mode: true }, 'mode must be "lease" or "transactional"'],
    [{ ...minimal, headers: { a: 1 } }, "headers.a must be a string"],
    [
      { ...minimal, fixtures: { create: { method: "POST", path: "/x" } } },
      "alternateBody is required",
    ],
    [
      {
        ...minimal,
        fixtures: { create: { method: "P O", path: "/x", alternateBody: {} } },
      },
      "method must be",
    ],
    [
      { ...minimal, fixtures: { throws: { method: "POST", path: "x" } } },
      "path must start with /",
    ],
    [
      { ...minimal, fixtures: { count: { path: "count" } } },
      "count.path must start with /",
    ],
    [
      {
        ...minimal,
        fixtures: { slow: { method: "POST", path: "/s", workMs: 10 } },
      },
      "workMs must be",
    ],
    [
      {
        ...minimal,
        fixtures: { release: { method: "POST", path: "/r", status: 200 } },
      },
      "release.status must be",
    ],
    [
      {
        ...minimal,
        fixtures: {
          shortRetention: { method: "POST", path: "/r", retentionMs: 1 },
        },
      },
      "retentionMs must be",
    ],
    [
      { ...minimal, fixtures: { noPrincipal: { omitHeaders: [] } } },
      "omitHeaders must be",
    ],
  ])("rejects %j", (value, message) => {
    expect(() => validateConfig(value)).toThrow(ConfigError);
    expect(() => validateConfig(value)).toThrow(message);
  });

  it("lists every problem at once", () => {
    expect(() => validateConfig({ keySyntax: "raw" })).toThrow(
      /keyMaxLength[\s\S]*requestBodyCap[\s\S]*keySyntax/,
    );
  });
});

describe("summarize and formatHuman", () => {
  const results: RowResult[] = [
    { row: "1", title: "a", outcome: "pass", messages: [], durationMs: 1 },
    {
      row: "2",
      title: "b",
      outcome: "not_run",
      messages: ["not run: fixture create missing"],
      durationMs: 0,
    },
    {
      row: "9",
      title: "c",
      outcome: "not_testable",
      messages: ["not testable black-box here"],
      durationMs: 0,
    },
    {
      row: "12",
      title: "d",
      outcome: "skipped",
      messages: ["skipped by --only"],
      durationMs: 0,
    },
  ];

  it("is ok without --require-all and not ok with it when a row was not run", () => {
    expect(summarize(results, false)).toStrictEqual({
      pass: 1,
      fail: 0,
      notRun: 1,
      notTestable: 1,
      skipped: 1,
      ok: true,
    });
    expect(summarize(results, true).ok).toBe(false);
    expect(
      summarize(
        [
          ...results,
          {
            row: "5",
            title: "e",
            outcome: "fail",
            messages: ["x"],
            durationMs: 1,
          },
        ],
        false,
      ).ok,
    ).toBe(false);
  });

  it("formats one line per row plus messages and a summary", () => {
    const text = formatHuman("http://t", results, summarize(results, false));
    expect(text).toContain("row 1   pass");
    expect(text).toContain("row 2   not run");
    expect(text).toContain("      not run: fixture create missing");
    expect(text).toContain("row 9   not testable");
    expect(text).toMatch(
      /summary: 1 passed, 0 failed, 1 not run, 1 not testable, 1 skipped: OK$/,
    );
    expect(text.split("\n")[0]).toBe(
      "idemfence conformance, Contract group, target http://t",
    );
  });

  const transactional: RowResult[] = [
    { row: "1", title: "a", outcome: "pass", messages: [], durationMs: 1 },
    {
      row: "12",
      title: "d",
      outcome: "not_applicable",
      messages: [
        `${NOT_APPLICABLE_IN_TRANSACTIONAL_MODE}: a throw is not stored`,
      ],
      durationMs: 0,
    },
    { row: "13", title: "e", outcome: "pass", messages: [], durationMs: 1 },
  ];

  it("counts not-applicable rows separately; --require-all accepts them", () => {
    expect(summarize(transactional, true)).toStrictEqual({
      pass: 2,
      fail: 0,
      notRun: 0,
      notTestable: 0,
      notApplicable: 1,
      skipped: 0,
      ok: true,
    });
    // Absent, not zero, when no row is not applicable.
    expect("notApplicable" in summarize(results, false)).toBe(false);
  });

  it("labels not-applicable rows and names the transactional mode", () => {
    const text = formatHuman(
      "http://t",
      transactional,
      summarize(transactional, true),
      "transactional",
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "idemfence conformance, Contract group, target http://t, transactional mode",
    );
    expect(text).toContain("row 12  not applicable d");
    expect(text).toContain("row 13  pass           e");
    expect(text).toContain(
      "      not applicable in transactional mode: a throw is not stored",
    );
    expect(text).not.toContain("not testable black-box");
    expect(text).toMatch(
      /summary: 2 passed, 0 failed, 0 not run, 0 not testable, 1 not applicable, 0 skipped: OK$/,
    );
  });
});

describe("runCrashGroup configuration", () => {
  const crashFixtures = {
    crash: { method: "POST", path: "/crash" },
    count: { path: "/count" },
  };
  const commands = { kill: ["true"], start: ["true"], readyPath: "/healthz" };

  it("needs the crash and count fixtures and the crash section", async () => {
    await expect(
      runCrashGroup("http://127.0.0.1:1", validateConfig(minimal)),
    ).rejects.toThrow(/crash and count fixtures[\s\S]*crash section/);
  });

  it("needs crash.leaseMs in lease mode, not in transactional mode", async () => {
    await expect(
      runCrashGroup(
        "http://127.0.0.1:1",
        validateConfig({
          ...minimal,
          fixtures: crashFixtures,
          crash: commands,
        }),
      ),
    ).rejects.toThrow("crash.leaseMs in lease mode");
    // Transactional mode passes validation and goes on to the target, here unreachable.
    await expect(
      runCrashGroup(
        "http://127.0.0.1:1",
        validateConfig({
          ...minimal,
          mode: "transactional",
          fixtures: crashFixtures,
          crash: commands,
        }),
      ),
    ).rejects.not.toBeInstanceOf(ConfigError);
  });
});

describe("runContractGroup and the target's mode", () => {
  // Rows that need no request: the rest are skipped, so nothing is sent.
  const offline = { ...minimal, acknowledgeSideEffects: true as const };

  it("lease mode: rows 9, 13 and 14 are not testable", async () => {
    const results = await runContractGroup(
      "http://127.0.0.1:1",
      validateConfig(offline),
      { only: [9, 13, 14] },
    );
    const byRow = Object.fromEntries(results.map((r) => [r.row, r]));
    for (const row of ["9", "13", "14"]) {
      expect(byRow[row]?.outcome).toBe("not_testable");
    }
    expect(byRow["13"]?.messages).toStrictEqual([
      "not testable black-box here (covered by step 2.2)",
    ]);
  });

  it("transactional mode: rows 9 and 12 are not applicable, row 14 stays not testable", async () => {
    const results = await runContractGroup(
      "http://127.0.0.1:1",
      validateConfig({ ...offline, mode: "transactional" }),
      { only: [9, 12, 14] },
    );
    const byRow = Object.fromEntries(results.map((r) => [r.row, r]));
    expect(byRow["9"]?.outcome).toBe("not_applicable");
    expect(byRow["12"]?.outcome).toBe("not_applicable");
    expect(byRow["12"]?.messages[0]).toMatch(
      /^not applicable in transactional mode: /,
    );
    expect(byRow["14"]?.outcome).toBe("not_testable");
    expect(results.filter((r) => r.outcome === "skipped")).toHaveLength(13);
  });
});

describe("keys", () => {
  it("are fresh UUIDs with the idemfence-conformance- prefix", () => {
    const keys = new Set(Array.from({ length: 50 }, () => newKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) {
      expect(key.startsWith(KEY_PREFIX)).toBe(true);
      expect(key).toMatch(
        /^idemfence-conformance-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(key.length).toBeLessThanOrEqual(255);
    }
  });
});

describe("the built CLI", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "idemfence-conformance-"));
  const run = async (config: unknown) => {
    const file = join(dir, "target.json");
    writeFileSync(file, JSON.stringify(config));
    try {
      await promisify(execFile)(process.execPath, [
        cli,
        "--url",
        "http://127.0.0.1:1",
        "--config",
        file,
      ]);
      return { code: 0, stderr: "" };
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      return { code: failure.code ?? -1, stderr: failure.stderr ?? "" };
    }
  };

  it("refuses to run without the side-effects acknowledgement (exit 2)", async () => {
    try {
      for (const config of [
        { keyMaxLength: 255, requestBodyCap: 1 },
        { acknowledgeSideEffects: false, keyMaxLength: 255, requestBodyCap: 1 },
      ]) {
        const { code, stderr } = await run(config);
        expect(code).toBe(2);
        expect(stderr).toContain(SIDE_EFFECTS_MESSAGE);
        expect(stderr).not.toContain("running the Contract group");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("classifyIteration", () => {
  const body = Buffer.from('{"id":1}');
  const ok = (
    status: number,
    extra: Record<string, string> = {},
  ): BurstReply => ({
    status,
    headers: { "content-type": "application/json", ...extra },
    bytes: body,
  });
  const replay = (): BurstReply => ok(201, { "idempotent-replayed": "true" });
  const inFlight = (retryAfter = "1"): BurstReply => ({
    status: 409,
    headers: {
      "content-type": "application/problem+json",
      link: '<https://d/x#in-flight>; rel="describedby"',
      "retry-after": retryAfter,
    },
    bytes: Buffer.from(
      JSON.stringify({
        type: "https://d/x#in-flight",
        title: "t",
        status: 409,
        detail: "d",
      }),
    ),
  });

  it("accepts one winner, replays and valid 409s", () => {
    const result = classifyIteration(
      [ok(201), replay(), inFlight(), replay(), inFlight("3")],
      1,
    );
    expect(result.ok).toBe(true);
    expect(result.histogram).toStrictEqual({
      "201": 1,
      "201 replayed": 2,
      "409": 2,
    });
  });

  it.each([
    ["a duplicate side effect", [ok(201), replay()], 2, "count changed by 2"],
    [
      "two winners",
      [ok(201), ok(201)],
      1,
      "exactly one non-replayed 2xx, got 2",
    ],
    [
      "no winner",
      [replay(), inFlight()],
      1,
      "exactly one non-replayed 2xx, got 0",
    ],
    [
      "a 5xx",
      [ok(201), { status: 503, headers: {}, bytes: Buffer.alloc(0) }],
      1,
      "server error 503",
    ],
    [
      "a connection error",
      [ok(201), { error: "socket hang up" }],
      1,
      "1 connection error(s), first: socket hang up",
    ],
    [
      "a 409 without Retry-After",
      [ok(201), inFlight("")],
      1,
      "Retry-After should be a positive integer",
    ],
    [
      "a replay with a different body",
      [ok(201), { ...replay(), bytes: Buffer.from("other") } as BurstReply],
      1,
      "not byte-identical",
    ],
    [
      "an unexpected 4xx",
      [ok(201), { status: 422, headers: {}, bytes: Buffer.alloc(0) }],
      1,
      "unexpected response 422",
    ],
  ] as const)("rejects %s", (_name, replies, delta, message) => {
    const result = classifyIteration([...replies], delta);
    expect(result.ok).toBe(false);
    expect(result.messages.join(" ")).toContain(message);
  });
});
