import { describe, expect, it } from "vitest";
import { parseIdempotencyKey } from "../src/key.js";
import {
  type ProblemKind,
  problemResponse,
  retryAfterSeconds,
} from "../src/problem.js";

const config = {
  docsUrl: "https://example.com/docs/idempotency",
  storeUnavailableRetryAfter: 5_000,
};

async function inspect(response: Response) {
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    link: response.headers.get("link"),
    retryAfter: response.headers.get("retry-after"),
    body: JSON.parse(text) as Record<string, unknown>,
    text,
  };
}

const expected: Record<ProblemKind, { status: number; title: string }> = {
  "key-missing": { status: 400, title: "Idempotency-Key is missing" },
  "key-malformed": { status: 400, title: "Idempotency-Key is malformed" },
  "key-reused": { status: 422, title: "Idempotency-Key is already used" },
  "in-flight": {
    status: 409,
    title: "A request is outstanding for this Idempotency-Key",
  },
  "store-unavailable": {
    status: 503,
    title: "Idempotency store is unavailable",
  },
  "body-too-large": { status: 413, title: "Request body is too large" },
  "configuration-error": {
    status: 500,
    title: "Idempotency middleware is misconfigured",
  },
};

function build(kind: ProblemKind, retryAfterMs?: number): Response {
  if (kind === "in-flight") {
    return problemResponse(kind, config, {
      retryAfterMs: retryAfterMs ?? 1_000,
    });
  }
  return retryAfterMs === undefined
    ? problemResponse(kind, config)
    : problemResponse(kind, config, { retryAfterMs });
}

async function expectProblem(
  kind: ProblemKind,
  retryAfter: string | null,
  retryAfterMs?: number,
): Promise<void> {
  const result = await inspect(build(kind, retryAfterMs));
  const type = `https://example.com/docs/idempotency#${kind}`;
  expect(result.status).toBe(expected[kind].status);
  expect(result.contentType).toBe("application/problem+json");
  expect(result.link).toBe(`<${type}>; rel="describedby"`);
  expect(result.retryAfter).toBe(retryAfter);
  expect(Object.keys(result.body).sort()).toStrictEqual([
    "detail",
    "status",
    "title",
    "type",
  ]);
  expect(result.body.type).toBe(type);
  expect(result.body.title).toBe(expected[kind].title);
  expect(result.body.status).toBe(expected[kind].status);
  expect(typeof result.body.detail).toBe("string");
  expect(result.body.detail).not.toBe("");
}

describe("problem responses", () => {
  it("key-missing", async () => {
    await expectProblem("key-missing", null);
  });

  it("key-malformed", async () => {
    await expectProblem("key-malformed", null);
  });

  it("key-reused", async () => {
    await expectProblem("key-reused", null);
  });

  it("in-flight, with Retry-After rounded up from the remaining lease", async () => {
    await expectProblem("in-flight", "1", 250);
    await expectProblem("in-flight", "1", 1_000);
    await expectProblem("in-flight", "2", 1_001);
    await expectProblem("in-flight", "1", 0);
    await expectProblem("in-flight", "1", -40);
    await expectProblem("in-flight", "30", 29_999);
  });

  it("store-unavailable, with the configured or given Retry-After", async () => {
    await expectProblem("store-unavailable", "5");
    await expectProblem("store-unavailable", "1", 250);
    await expectProblem("store-unavailable", "2", 1_001);
  });

  it("body-too-large", async () => {
    await expectProblem("body-too-large", null);
  });

  it("configuration-error", async () => {
    await expectProblem("configuration-error", null);
  });
});

describe("retryAfterSeconds", () => {
  it("rounds up to whole seconds with a minimum of 1", () => {
    expect(retryAfterSeconds(250)).toBe(1);
    expect(retryAfterSeconds(1_001)).toBe(2);
    expect(retryAfterSeconds(0)).toBe(1);
    expect(() => retryAfterSeconds(Number.NaN)).toThrow(RangeError);
  });
});

describe("problem type URIs", () => {
  it("replaces an existing fragment in docsUrl", async () => {
    const response = problemResponse("key-missing", {
      ...config,
      docsUrl: "https://example.com/contract.md#top",
    });
    const result = await inspect(response);
    expect(result.body.type).toBe(
      "https://example.com/contract.md#key-missing",
    );
  });
});

describe("client keys are never echoed", () => {
  it.each([
    ["malformed (unquoted) key", "client-secret-key-0001", "key-malformed"],
    [
      "over-length key",
      `"client-secret-key-0002${"x".repeat(300)}"`,
      "key-malformed",
    ],
  ] as const)("%s", async (_name, value, kind) => {
    const headers = new Headers({ "Idempotency-Key": value });
    const parsed = parseIdempotencyKey(headers, {
      keyMaxLength: 255,
      keySyntax: "sf-string",
      required: true,
    });
    expect(parsed).toStrictEqual({ error: kind });

    const response = problemResponse(kind, config);
    const result = await inspect(response);
    const submitted = value.replaceAll('"', "").slice(0, 22);
    expect(result.text).not.toContain(submitted);
    for (const [, headerValue] of response.headers) {
      expect(headerValue).not.toContain(submitted);
    }
  });

  it("for every problem kind", async () => {
    const submitted = "client-secret-key-0003";
    for (const kind of Object.keys(expected) as ProblemKind[]) {
      const response = build(kind);
      const result = await inspect(response);
      expect(result.text).not.toContain(submitted);
      for (const [, headerValue] of response.headers) {
        expect(headerValue).not.toContain(submitted);
      }
    }
  });
});
