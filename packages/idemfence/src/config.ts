/**
 * Stable codes for {@link IdemfenceConfigError}:
 *
 * - `STORE_INVALID`: `store` is missing or lacks a `begin`, `renew`, `complete` or `release`
 *   function.
 * - `SCOPE_MISSING`: `scope` is missing or not a function.
 * - `SECRET_TOO_SHORT`: `secret` or an entry of `previousSecrets` is missing, not a string or
 *   `Uint8Array`, or shorter than 32 bytes (strings count UTF-8 bytes).
 * - `DOCS_URL_NOT_HTTPS`: `docsUrl` is missing, not a valid URL, or not `https:`.
 * - `DURATION_INVALID`: `retention`, `lease` or `storeUnavailableRetryAfter` is not a positive
 *   integer number of milliseconds or a string matching `/^\d+(ms|s|m|h|d)$/`.
 * - `LEASE_NOT_SHORTER_THAN_RETENTION`: `lease` is greater than or equal to `retention`.
 * - `KEY_MAX_LENGTH_INVALID`: `keyMaxLength` is not an integer from 1 to 255.
 * - `BODY_CAP_INVALID`: `requestBodyCap` or `responseBodyCap` is not a positive integer.
 * - `RELEASE_STATUS_INVALID`: `releaseStatuses` is not an array of integers from 400 to 599.
 * - `WEBCRYPTO_MISSING`: `globalThis.crypto.subtle` is not available in this runtime.
 */
export type IdemfenceConfigErrorCode =
  | "STORE_INVALID"
  | "SCOPE_MISSING"
  | "SECRET_TOO_SHORT"
  | "DOCS_URL_NOT_HTTPS"
  | "DURATION_INVALID"
  | "LEASE_NOT_SHORTER_THAN_RETENTION"
  | "KEY_MAX_LENGTH_INVALID"
  | "BODY_CAP_INVALID"
  | "RELEASE_STATUS_INVALID"
  | "WEBCRYPTO_MISSING";

/** Thrown at construction when idemfence options are invalid. Messages never include secrets. */
export class IdemfenceConfigError extends Error {
  readonly code: IdemfenceConfigErrorCode;

  constructor(code: IdemfenceConfigErrorCode, message: string) {
    super(message);
    this.name = "IdemfenceConfigError";
    this.code = code;
  }
}

/** The store operations idemfence calls. Only their presence is checked at construction. */
export interface Store {
  begin(...args: never[]): unknown;
  renew(...args: never[]): unknown;
  complete(...args: never[]): unknown;
  release(...args: never[]): unknown;
}

/** Positive integer milliseconds, or a string such as `"30s"` (units: ms, s, m, h, d). */
export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

export interface IdemfenceOptions<TRequest = unknown> {
  store: Store;
  /** Returns the principal that owns the key; `undefined` when there is none (contract row 4). */
  scope: (request: TRequest) => string | undefined;
  secret: string | Uint8Array;
  previousSecrets?: readonly (string | Uint8Array)[];
  docsUrl: string;
  retention?: Duration;
  lease?: Duration;
  keyMaxLength?: number;
  requestBodyCap?: number;
  responseBodyCap?: number;
  storeUnavailableRetryAfter?: Duration;
  releaseStatuses?: readonly number[];
  namespace?: string;
  headerAllowlist?: readonly string[];
  required?: boolean;
}

/** Fully-defaulted, frozen configuration. Durations are in milliseconds, caps in bytes. */
export interface ResolvedConfig<TRequest = unknown> {
  readonly store: Store;
  readonly scope: (request: TRequest) => string | undefined;
  readonly secret: Uint8Array;
  readonly previousSecrets: readonly Uint8Array[];
  readonly docsUrl: string;
  readonly retention: number;
  readonly lease: number;
  readonly keyMaxLength: number;
  readonly requestBodyCap: number;
  readonly responseBodyCap: number;
  readonly storeUnavailableRetryAfter: number;
  readonly releaseStatuses: readonly number[];
  readonly namespace: string;
  readonly headerAllowlist: readonly string[];
  readonly required: boolean;
}

// The package compiles against the ES2022 library only, so the runtime globals it needs
// are typed here.
const runtime = globalThis as unknown as {
  crypto?: { subtle?: unknown };
  TextEncoder: new () => { encode(input: string): Uint8Array };
  URL: new (input: string) => { protocol: string; href: string };
};

const MIN_SECRET_BYTES = 32;
const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;
const STORE_METHODS = ["begin", "renew", "complete", "release"] as const;

export function resolveConfig<TRequest>(
  options: IdemfenceOptions<TRequest>,
): ResolvedConfig<TRequest> {
  if (
    typeof runtime.crypto?.subtle !== "object" ||
    runtime.crypto.subtle === null
  ) {
    throw new IdemfenceConfigError(
      "WEBCRYPTO_MISSING",
      "idemfence requires the Web Crypto API (globalThis.crypto.subtle), which this runtime does not provide.",
    );
  }

  const store: unknown = options.store;
  if (
    typeof store !== "object" ||
    store === null ||
    !STORE_METHODS.every(
      (method) =>
        typeof (store as Record<string, unknown>)[method] === "function",
    )
  ) {
    throw new IdemfenceConfigError(
      "STORE_INVALID",
      "Option `store` must be an object with begin, renew, complete and release functions.",
    );
  }

  if (typeof options.scope !== "function") {
    throw new IdemfenceConfigError(
      "SCOPE_MISSING",
      "Option `scope` is required and must be a function that returns the request's principal.",
    );
  }

  const secret = secretBytes("secret", options.secret);
  const previousSecrets = options.previousSecrets ?? [];
  if (!Array.isArray(previousSecrets)) {
    throw new IdemfenceConfigError(
      "SECRET_TOO_SHORT",
      "Option `previousSecrets` must be an array of secrets of at least 32 bytes each.",
    );
  }

  const retention = parseDuration("retention", options.retention ?? "24h");
  const lease = parseDuration("lease", options.lease ?? "30s");
  const storeUnavailableRetryAfter = parseDuration(
    "storeUnavailableRetryAfter",
    options.storeUnavailableRetryAfter ?? "5s",
  );
  if (lease >= retention) {
    throw new IdemfenceConfigError(
      "LEASE_NOT_SHORTER_THAN_RETENTION",
      "Option `lease` must be shorter than option `retention`.",
    );
  }

  const keyMaxLength = options.keyMaxLength ?? 255;
  if (
    !Number.isInteger(keyMaxLength) ||
    keyMaxLength < 1 ||
    keyMaxLength > 255
  ) {
    throw new IdemfenceConfigError(
      "KEY_MAX_LENGTH_INVALID",
      "Option `keyMaxLength` must be an integer from 1 to 255.",
    );
  }

  const releaseStatuses = options.releaseStatuses ?? [408, 425, 429];
  if (
    !Array.isArray(releaseStatuses) ||
    !releaseStatuses.every(
      (status) => Number.isInteger(status) && status >= 400 && status <= 599,
    )
  ) {
    throw new IdemfenceConfigError(
      "RELEASE_STATUS_INVALID",
      "Option `releaseStatuses` must contain only integer status codes from 400 to 599; releasing a success or redirect status would let a completed operation run twice.",
    );
  }

  return Object.freeze({
    store: options.store,
    scope: options.scope,
    secret,
    previousSecrets: Object.freeze(
      previousSecrets.map((value, index) =>
        secretBytes(`previousSecrets[${index}]`, value),
      ),
    ),
    docsUrl: httpsUrl(options.docsUrl),
    retention,
    lease,
    keyMaxLength,
    requestBodyCap: bodyCap("requestBodyCap", options.requestBodyCap),
    responseBodyCap: bodyCap("responseBodyCap", options.responseBodyCap),
    storeUnavailableRetryAfter,
    releaseStatuses: Object.freeze([...releaseStatuses]),
    namespace: options.namespace ?? "idemfence",
    headerAllowlist: Object.freeze([...(options.headerAllowlist ?? [])]),
    required: options.required ?? true,
  });
}

function secretBytes(option: string, value: unknown): Uint8Array {
  const bytes =
    typeof value === "string"
      ? new runtime.TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? new Uint8Array(value)
        : undefined;
  if (bytes === undefined || bytes.byteLength < MIN_SECRET_BYTES) {
    throw new IdemfenceConfigError(
      "SECRET_TOO_SHORT",
      `Option \`${option}\` must be a string or Uint8Array of at least ${MIN_SECRET_BYTES} bytes (strings count UTF-8 bytes).`,
    );
  }
  return bytes;
}

function parseDuration(option: string, value: unknown): number {
  let ms: number | undefined;
  if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string") {
    const match = DURATION_PATTERN.exec(value);
    const amount = match?.[1];
    const unit = match?.[2] as keyof typeof UNIT_MS | undefined;
    if (amount !== undefined && unit !== undefined) {
      ms = Number(amount) * UNIT_MS[unit];
    }
  }
  if (ms === undefined || !Number.isSafeInteger(ms) || ms <= 0) {
    throw new IdemfenceConfigError(
      "DURATION_INVALID",
      `Option \`${option}\` must be a positive integer number of milliseconds or a string such as "30s" (units: ms, s, m, h, d).`,
    );
  }
  return ms;
}

function httpsUrl(value: unknown): string {
  let url: { protocol: string; href: string } | undefined;
  if (typeof value === "string") {
    try {
      url = new runtime.URL(value);
    } catch {
      url = undefined;
    }
  }
  if (url?.protocol !== "https:") {
    throw new IdemfenceConfigError(
      "DOCS_URL_NOT_HTTPS",
      "Option `docsUrl` is required and must be an https: URL.",
    );
  }
  return url.href;
}

function bodyCap(option: string, value: unknown): number {
  const cap = value ?? 1_048_576;
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0) {
    throw new IdemfenceConfigError(
      "BODY_CAP_INVALID",
      `Option \`${option}\` must be a positive integer number of bytes.`,
    );
  }
  return cap;
}
