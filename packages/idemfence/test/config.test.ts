import { describe, expect, it } from "vitest";
import {
  type IdemfenceOptions,
  resolveConfig,
  resolveRoute,
} from "../src/config.js";
import {
  IdemfenceConfigError,
  type IdemfenceConfigErrorCode,
} from "../src/index.js";

const SECRET = "test-secret-0123456789-abcdefghijklmnop";
const SHORT_SECRET = "short-secret-value";

const store = {
  async ready() {},
  async begin() {
    return { outcome: "mismatch" as const };
  },
  async renew() {
    return "renewed" as const;
  },
  async complete() {
    return "completed" as const;
  },
  async release() {
    return "released" as const;
  },
  async purgeExpired() {
    return 0;
  },
};
const scope = () => "principal-1";

function required(): IdemfenceOptions {
  return {
    store,
    scope,
    secret: SECRET,
    docsUrl: "https://example.com/docs/idempotency",
  };
}

// Calls resolveConfig with the required options plus `overrides` (unknown values on purpose,
// to exercise runtime validation) and returns the thrown error.
function configError(overrides: Record<string, unknown>): IdemfenceConfigError {
  try {
    resolveConfig({ ...required(), ...overrides } as IdemfenceOptions);
  } catch (error) {
    if (error instanceof IdemfenceConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error(
    `expected IdemfenceConfigError for ${JSON.stringify(overrides)}`,
  );
}

function expectCode(
  code: IdemfenceConfigErrorCode,
  cases: Record<string, unknown>[],
): void {
  for (const overrides of cases) {
    const error = configError(overrides);
    expect(error.code, JSON.stringify(overrides)).toBe(code);
    expect(error.name).toBe("IdemfenceConfigError");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(SHORT_SECRET);
  }
}

describe("resolveConfig defaults", () => {
  it("fills every default when only required options are given", () => {
    const config = resolveConfig(required());

    expect(config).toStrictEqual({
      store,
      scope,
      secret: new TextEncoder().encode(SECRET),
      previousSecrets: [],
      docsUrl: "https://example.com/docs/idempotency",
      retention: 86_400_000,
      lease: 30_000,
      keyMaxLength: 255,
      keySyntax: "sf-string",
      requestBodyCap: 1_048_576,
      responseBodyCap: 1_048_576,
      storeUnavailableRetryAfter: 5_000,
      releaseStatuses: [408, 425, 429],
      namespace: "idemfence",
      headerAllowlist: [],
      required: true,
      logger: expect.objectContaining({
        warn: expect.any(Function),
        error: expect.any(Function),
      }),
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.previousSecrets)).toBe(true);
    expect(Object.isFrozen(config.releaseStatuses)).toBe(true);
    expect(Object.isFrozen(config.headerAllowlist)).toBe(true);
  });

  it("accepts every duration form", () => {
    const config = resolveConfig({
      ...required(),
      retention: "2d",
      lease: 1_500,
      storeUnavailableRetryAfter: "250ms",
    });
    expect(config.retention).toBe(172_800_000);
    expect(config.lease).toBe(1_500);
    expect(config.storeUnavailableRetryAfter).toBe(250);

    expect(resolveConfig({ ...required(), lease: "45s" }).lease).toBe(45_000);
    expect(resolveConfig({ ...required(), lease: "5m" }).lease).toBe(300_000);
    expect(
      resolveConfig({ ...required(), retention: "1h", lease: "59m" }).retention,
    ).toBe(3_600_000);
  });

  it("lowercases and de-duplicates the header allowlist", () => {
    const config = resolveConfig({
      ...required(),
      headerAllowlist: ["X-Tenant-ID", "accept-language", "x-tenant-id"],
    });
    expect(config.headerAllowlist).toStrictEqual([
      "x-tenant-id",
      "accept-language",
    ]);
  });

  it("copies byte secrets so later caller mutation has no effect", () => {
    const bytes = new Uint8Array(32).fill(7);
    const config = resolveConfig({
      ...required(),
      secret: bytes,
      previousSecrets: [bytes],
    });
    bytes.fill(0);
    expect(config.secret).toStrictEqual(new Uint8Array(32).fill(7));
    expect(config.previousSecrets[0]).toStrictEqual(new Uint8Array(32).fill(7));
  });
});

describe("IdemfenceConfigError codes", () => {
  it("STORE_INVALID", () => {
    expectCode("STORE_INVALID", [
      { store: undefined },
      { store: null },
      { store: "postgres" },
      { store: { begin() {}, renew() {}, complete() {} } },
      { store: { ...store, release: "not a function" } },
    ]);
  });

  it("SCOPE_MISSING", () => {
    expectCode("SCOPE_MISSING", [{ scope: undefined }, { scope: "user-id" }]);
  });

  it("SECRET_TOO_SHORT", () => {
    expectCode("SECRET_TOO_SHORT", [
      { secret: undefined },
      { secret: SHORT_SECRET },
      { secret: "x".repeat(31) },
      // 10 three-byte characters = 30 UTF-8 bytes, although 10 UTF-16 code units.
      { secret: "€".repeat(10) },
      { secret: new Uint8Array(31) },
      { secret: 1234 },
      { previousSecrets: [SHORT_SECRET] },
      { previousSecrets: [SECRET, new Uint8Array(16)] },
      { previousSecrets: SHORT_SECRET },
    ]);
  });

  it("DOCS_URL_NOT_HTTPS", () => {
    expectCode("DOCS_URL_NOT_HTTPS", [
      { docsUrl: undefined },
      { docsUrl: "http://example.com/docs" },
      { docsUrl: "not a url" },
      { docsUrl: "ftp://example.com/docs" },
    ]);
  });

  it("DURATION_INVALID", () => {
    expectCode("DURATION_INVALID", [
      { retention: 0 },
      { retention: -1 },
      { retention: 1.5 },
      { retention: Number.NaN },
      { lease: "30" },
      { lease: "1.5s" },
      { lease: "-5s" },
      { lease: "0s" },
      { lease: "30 s" },
      { lease: "30S" },
      { lease: "1w" },
      { retention: "99999999999999999999d" },
      { storeUnavailableRetryAfter: "soon" },
    ]);
  });

  it("LEASE_NOT_SHORTER_THAN_RETENTION", () => {
    expectCode("LEASE_NOT_SHORTER_THAN_RETENTION", [
      { lease: "1h", retention: "1h" },
      { lease: "2h", retention: "1h" },
      { lease: "25h" },
    ]);
  });

  it("KEY_MAX_LENGTH_INVALID", () => {
    expectCode("KEY_MAX_LENGTH_INVALID", [
      { keyMaxLength: 0 },
      { keyMaxLength: 256 },
      { keyMaxLength: 64.5 },
      { keyMaxLength: "255" },
    ]);
  });

  it("KEY_SYNTAX_INVALID", () => {
    expectCode("KEY_SYNTAX_INVALID", [
      { keySyntax: "raw" },
      { keySyntax: "SF-STRING" },
      { keySyntax: "" },
      { keySyntax: true },
    ]);
  });

  it("BODY_CAP_INVALID", () => {
    expectCode("BODY_CAP_INVALID", [
      { requestBodyCap: 0 },
      { requestBodyCap: -1 },
      { requestBodyCap: 1.5 },
      { responseBodyCap: "1MiB" },
      { responseBodyCap: Number.POSITIVE_INFINITY },
    ]);
  });

  it("RELEASE_STATUS_INVALID", () => {
    expectCode("RELEASE_STATUS_INVALID", [
      { releaseStatuses: [200] },
      { releaseStatuses: [408, 201] },
      { releaseStatuses: [302] },
      { releaseStatuses: [100] },
      { releaseStatuses: [600] },
      { releaseStatuses: [429.5] },
      { releaseStatuses: ["429"] },
      { releaseStatuses: 429 },
    ]);
  });

  it("NAMESPACE_INVALID", () => {
    expectCode("NAMESPACE_INVALID", [
      { namespace: "" },
      { namespace: "has space" },
      { namespace: "tab\there" },
      { namespace: "café" },
      { namespace: "x".repeat(65) },
      { namespace: 42 },
    ]);
  });

  it("HEADER_ALLOWLIST_INVALID", () => {
    expectCode("HEADER_ALLOWLIST_INVALID", [
      { headerAllowlist: "accept-language" },
      { headerAllowlist: [""] },
      { headerAllowlist: ["x header"] },
      { headerAllowlist: ["x-header:"] },
      { headerAllowlist: ["x-tenant", 7] },
      { headerAllowlist: ["Content-Type"] },
      { headerAllowlist: ["Authorization"] },
      { headerAllowlist: ["cookie"] },
      { headerAllowlist: ["Idempotency-Key"] },
      { headerAllowlist: ["transfer-encoding"] },
      { headerAllowlist: ["traceparent"] },
      { headerAllowlist: ["Set-Cookie"] },
      { headerAllowlist: ["date"] },
    ]);
  });

  it("LOGGER_INVALID", () => {
    expectCode("LOGGER_INVALID", [
      { logger: console.log },
      { logger: { warn() {} } },
      { logger: { warn: "yes", error() {} } },
      { logger: "console" },
    ]);
  });

  it("REQUIRED_INVALID", () => {
    expectCode("REQUIRED_INVALID", [
      { required: "true" },
      { required: 1 },
      { required: {} },
    ]);
  });
});

describe("route mode", () => {
  it("defaults to lease and accepts transactional on a store with transaction()", () => {
    const transactional = {
      ...store,
      lockTimeoutMs: 250,
      async transaction<T>(fn: (tx: never) => Promise<T>) {
        return fn(undefined as never);
      },
    };
    const config = resolveConfig({ ...required(), store: transactional });
    expect(resolveRoute(config, { routeTemplate: "/a" }).mode).toBe("lease");
    expect(
      resolveRoute(config, { routeTemplate: "/a", mode: "transactional" }).mode,
    ).toBe("transactional");
  });

  it("ROUTE_MODE_INVALID for a value other than lease or transactional", () => {
    const config = resolveConfig(required());
    for (const mode of ["tx", "", 1, "LEASE"]) {
      expect(() =>
        resolveRoute(config, { routeTemplate: "/a", mode } as never),
      ).toThrow(expect.objectContaining({ code: "ROUTE_MODE_INVALID" }));
    }
  });

  it("MODE_UNSUPPORTED when the store cannot open transactions", () => {
    const config = resolveConfig(required());
    expect(() =>
      resolveRoute(config, { routeTemplate: "/a", mode: "transactional" }),
    ).toThrow(
      expect.objectContaining({
        name: "IdemfenceConfigError",
        code: "MODE_UNSUPPORTED",
      }),
    );
  });
});
