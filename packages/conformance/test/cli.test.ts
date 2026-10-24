import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  formatHuman,
  KEY_PREFIX,
  newKey,
  parseCliArgs,
  type RowResult,
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
    });
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
      fixtures: {},
    });
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
