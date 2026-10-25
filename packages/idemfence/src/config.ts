import type { Store, TransactionalStore } from "./store.js";

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
 * - `KEY_SYNTAX_INVALID`: `keySyntax` is not `"sf-string"` or `"sf-string-or-raw"`.
 * - `BODY_CAP_INVALID`: `requestBodyCap` or `responseBodyCap` is not a positive integer.
 * - `RELEASE_STATUS_INVALID`: `releaseStatuses` is not an array of integers from 400 to 599.
 * - `NAMESPACE_INVALID`: `namespace` is not a string of 1 to 64 printable ASCII characters
 *   (0x21 to 0x7E, so no spaces).
 * - `HEADER_ALLOWLIST_INVALID`: `headerAllowlist` is not an array of HTTP field names
 *   (RFC 9110 tokens), or names a header that must not be fingerprinted: `content-type`
 *   (always included), a header on the contract's response denylist, `authorization`,
 *   `cookie` or `idempotency-key`.
 * - `REQUIRED_INVALID`: `required` is not a boolean.
 * - `LOGGER_INVALID`: `logger` is not an object with `warn` and `error` functions.
 * - `ROUTE_TEMPLATE_INVALID`: a route's `routeTemplate` is not a string of 1 to 2048
 *   printable ASCII characters starting with `/`.
 * - `ROUTE_FLAG_INVALID`: a route's `allowSetCookieReplay` or `failOpen` is not a boolean.
 * - `ROUTE_METHODS_INVALID`: a fetch route's `methods` is not a non-empty array of HTTP
 *   method tokens.
 * - `WEBCRYPTO_MISSING`: `globalThis.crypto.subtle` is not available in this runtime.
 * - `LOCK_TIMEOUT_INVALID`: a store's or transaction's `lockTimeout` is not a valid duration
 *   of at most 2147483647 milliseconds (the Postgres `lock_timeout` maximum).
 * - `ROUTE_MODE_INVALID`: a route's `mode` is not `"lease"` or `"transactional"`.
 * - `MODE_UNSUPPORTED`: a route uses `mode: "transactional"` but the configured store has no
 *   `openTransaction` function.
 * - `FAIL_OPEN_TRANSACTIONAL`: a route sets both `failOpen: true` and
 *   `mode: "transactional"`. Fail-open runs the handler without the store, and a
 *   transactional handler needs the store's transaction.
 */
export type IdemfenceConfigErrorCode =
  | "STORE_INVALID"
  | "SCOPE_MISSING"
  | "SECRET_TOO_SHORT"
  | "DOCS_URL_NOT_HTTPS"
  | "DURATION_INVALID"
  | "LEASE_NOT_SHORTER_THAN_RETENTION"
  | "KEY_MAX_LENGTH_INVALID"
  | "KEY_SYNTAX_INVALID"
  | "BODY_CAP_INVALID"
  | "RELEASE_STATUS_INVALID"
  | "NAMESPACE_INVALID"
  | "HEADER_ALLOWLIST_INVALID"
  | "REQUIRED_INVALID"
  | "LOGGER_INVALID"
  | "ROUTE_TEMPLATE_INVALID"
  | "ROUTE_FLAG_INVALID"
  | "ROUTE_METHODS_INVALID"
  | "WEBCRYPTO_MISSING"
  | "LOCK_TIMEOUT_INVALID"
  | "ROUTE_MODE_INVALID"
  | "MODE_UNSUPPORTED"
  | "FAIL_OPEN_TRANSACTIONAL";

/** Thrown at construction when idemfence options are invalid. Messages never include secrets. */
export class IdemfenceConfigError extends Error {
  readonly code: IdemfenceConfigErrorCode;

  constructor(code: IdemfenceConfigErrorCode, message: string) {
    super(message);
    this.name = "IdemfenceConfigError";
    this.code = code;
  }
}

export type KeySyntax = "sf-string" | "sf-string-or-raw";

/**
 * How a route's record is written (docs/contract.md section 7). `"lease"` claims the record
 * with a lease and a fencing token. `"transactional"` runs the handler inside one of the
 * store's transactions, exposed to it as `ctx.tx`, and writes the record inside that same
 * transaction, so the record and the handler's writes commit or roll back together; the
 * store must implement `openTransaction()`.
 */
export type RouteMode = "lease" | "transactional";

/** Positive integer milliseconds, or a string such as `"30s"` (units: ms, s, m, h, d). */
export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

/**
 * Fields attached to every log entry (docs/contract.md section 8). They never carry raw
 * client keys, bodies or header values.
 */
export interface LogFields {
  /** First 8 hex characters of the lookup key; absent before the key is computed. */
  readonly keyHash?: string;
  /** The contract row the entry relates to. */
  readonly row?: number;
  readonly outcome: string;
  readonly attempt?: number;
  /** The failing error's name and (when it has one) code; never its message. */
  readonly error?: { readonly name: string; readonly code?: string };
}

export interface Logger {
  warn(message: string, fields: LogFields): void;
  error(message: string, fields: LogFields): void;
}

export interface IdemfenceOptions<TRequest = unknown> {
  store: Store;
  /** Returns the principal that owns the key; `undefined` when there is none (contract row 4). */
  scope: (request: TRequest) => string | undefined;
  /** The current secret: at least 32 bytes (strings count UTF-8 bytes). */
  secret: string | Uint8Array;
  /**
   * Earlier secrets, newest first and oldest last. Derived downstream keys
   * (`ctx.deriveKey`) use the oldest configured secret: the last entry here, or `secret`
   * when this is empty. To rotate, set the new value as `secret` and put the old one at
   * the front of this list; no derived key changes. Removing the last (oldest) entry is a
   * deliberate re-key: every derived key changes, and a request whose attempts straddle the
   * removal gets a new downstream key on its later attempts.
   */
  previousSecrets?: readonly (string | Uint8Array)[];
  docsUrl: string;
  retention?: Duration;
  lease?: Duration;
  keyMaxLength?: number;
  /**
   * `"sf-string"` accepts only a Structured Field String. `"sf-string-or-raw"` also accepts an
   * unquoted key of 0x21 to 0x7E characters (no quotes or backslashes); `abc` and `"abc"` are
   * the same key.
   */
  keySyntax?: KeySyntax;
  requestBodyCap?: number;
  responseBodyCap?: number;
  storeUnavailableRetryAfter?: Duration;
  releaseStatuses?: readonly number[];
  namespace?: string;
  headerAllowlist?: readonly string[];
  required?: boolean;
  /** Receives warn and error entries; defaults to `console`. */
  logger?: Logger;
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
  readonly keySyntax: KeySyntax;
  readonly requestBodyCap: number;
  readonly responseBodyCap: number;
  readonly storeUnavailableRetryAfter: number;
  readonly releaseStatuses: readonly number[];
  readonly namespace: string;
  readonly headerAllowlist: readonly string[];
  readonly required: boolean;
  readonly logger: Logger;
}

/** Per-route configuration: the template plus optional overrides of the global options. */
export interface RouteConfig {
  /** The configured template, for example `/orders/:id`; part of the lookup key. */
  routeTemplate: string;
  required?: boolean;
  keySyntax?: KeySyntax;
  keyMaxLength?: number;
  requestBodyCap?: number;
  responseBodyCap?: number;
  releaseStatuses?: readonly number[];
  headerAllowlist?: readonly string[];
  storeUnavailableRetryAfter?: Duration;
  /** Replay `Set-Cookie` headers for this route (contract section 5); default false. */
  allowSetCookieReplay?: boolean;
  /**
   * Run the handler without idempotency when the store is unavailable (row 14); default
   * false. Not allowed with `mode: "transactional"` (`FAIL_OPEN_TRANSACTIONAL`).
   */
  failOpen?: boolean;
  /** `"lease"` (default) or `"transactional"`; see {@link RouteMode}. */
  mode?: RouteMode;
}

export interface ResolvedRoute {
  readonly routeTemplate: string;
  readonly mode: RouteMode;
  readonly required: boolean;
  readonly keySyntax: KeySyntax;
  readonly keyMaxLength: number;
  readonly requestBodyCap: number;
  readonly responseBodyCap: number;
  readonly releaseStatuses: readonly number[];
  readonly headerAllowlist: readonly string[];
  readonly storeUnavailableRetryAfter: number;
  readonly allowSetCookieReplay: boolean;
  readonly failOpen: boolean;
}

// The package compiles against the ES2022 library only, so the runtime globals it needs
// are typed here.
const runtime = globalThis as unknown as {
  crypto?: { subtle?: unknown };
  TextEncoder: new () => { encode(input: string): Uint8Array };
  URL: new (input: string) => { protocol: string; href: string };
  console: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
};

const MIN_SECRET_BYTES = 32;
const DEFAULT_LOCK_TIMEOUT = "250ms";
// Postgres lock_timeout is a 32-bit signed integer number of milliseconds.
const MAX_LOCK_TIMEOUT_MS = 2_147_483_647;
const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;
const STORE_METHODS = ["begin", "renew", "complete", "release"] as const;
const NAMESPACE_PATTERN = /^[\x21-\x7e]{1,64}$/;
const ROUTE_TEMPLATE_PATTERN = /^\/[\x21-\x7e]{0,2047}$/;
// RFC 9110 section 5.1: field-name = token.
const FIELD_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// content-type is always part of the fingerprint. The rest are on the contract's response
// denylist (section 5) or are volatile or carry secrets.
const NOT_ALLOWLISTABLE = new Set([
  "content-type",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "date",
  "server-timing",
  "traceparent",
  "tracestate",
  "set-cookie",
  "authorization",
  "cookie",
  "idempotency-key",
]);

const defaultLogger: Logger = {
  warn(message, fields) {
    runtime.console.warn(message, fields);
  },
  error(message, fields) {
    runtime.console.error(message, fields);
  },
};

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
  if (lease >= retention) {
    throw new IdemfenceConfigError(
      "LEASE_NOT_SHORTER_THAN_RETENTION",
      "Option `lease` must be shorter than option `retention`.",
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
    keyMaxLength: keyMaxLength(options.keyMaxLength),
    keySyntax: keySyntax(options.keySyntax),
    requestBodyCap: bodyCap("requestBodyCap", options.requestBodyCap),
    responseBodyCap: bodyCap("responseBodyCap", options.responseBodyCap),
    storeUnavailableRetryAfter: parseDuration(
      "storeUnavailableRetryAfter",
      options.storeUnavailableRetryAfter ?? "5s",
    ),
    releaseStatuses: releaseStatuses(options.releaseStatuses),
    namespace: namespace(options.namespace),
    headerAllowlist: headerAllowlist(options.headerAllowlist),
    required: booleanOption(
      "required",
      "REQUIRED_INVALID",
      options.required,
      true,
    ),
    logger: logger(options.logger),
  });
}

/** Validates a route and applies its overrides on top of the resolved configuration. */
export function resolveRoute<TRequest>(
  config: ResolvedConfig<TRequest>,
  route: RouteConfig,
): ResolvedRoute {
  const template: unknown = route.routeTemplate;
  if (typeof template !== "string" || !ROUTE_TEMPLATE_PATTERN.test(template)) {
    throw new IdemfenceConfigError(
      "ROUTE_TEMPLATE_INVALID",
      "Route option `routeTemplate` must be 1 to 2048 printable ASCII characters starting with `/`.",
    );
  }
  const resolved: ResolvedRoute = {
    routeTemplate: template,
    mode: routeMode(config.store, route.mode),
    required: booleanOption(
      "required",
      "REQUIRED_INVALID",
      route.required,
      config.required,
    ),
    keySyntax:
      route.keySyntax === undefined
        ? config.keySyntax
        : keySyntax(route.keySyntax),
    keyMaxLength:
      route.keyMaxLength === undefined
        ? config.keyMaxLength
        : keyMaxLength(route.keyMaxLength),
    requestBodyCap:
      route.requestBodyCap === undefined
        ? config.requestBodyCap
        : bodyCap("requestBodyCap", route.requestBodyCap),
    responseBodyCap:
      route.responseBodyCap === undefined
        ? config.responseBodyCap
        : bodyCap("responseBodyCap", route.responseBodyCap),
    releaseStatuses:
      route.releaseStatuses === undefined
        ? config.releaseStatuses
        : releaseStatuses(route.releaseStatuses),
    headerAllowlist:
      route.headerAllowlist === undefined
        ? config.headerAllowlist
        : headerAllowlist(route.headerAllowlist),
    storeUnavailableRetryAfter:
      route.storeUnavailableRetryAfter === undefined
        ? config.storeUnavailableRetryAfter
        : parseDuration(
            "storeUnavailableRetryAfter",
            route.storeUnavailableRetryAfter,
          ),
    allowSetCookieReplay: booleanOption(
      "allowSetCookieReplay",
      "ROUTE_FLAG_INVALID",
      route.allowSetCookieReplay,
      false,
    ),
    failOpen: booleanOption(
      "failOpen",
      "ROUTE_FLAG_INVALID",
      route.failOpen,
      false,
    ),
  };
  if (resolved.failOpen && resolved.mode === "transactional") {
    throw new IdemfenceConfigError(
      "FAIL_OPEN_TRANSACTIONAL",
      'Route options `failOpen: true` and `mode: "transactional"` cannot be combined: fail-open runs the handler without the store, and a transactional handler runs inside the store\'s transaction.',
    );
  }
  return Object.freeze(resolved);
}

/**
 * Validates a `lockTimeout` option (default 250 ms) and returns it in milliseconds; throws
 * `LOCK_TIMEOUT_INVALID`. Used by stores that open transactions.
 */
export function lockTimeoutMs(value: unknown): number {
  let ms: number | undefined;
  try {
    ms = parseDuration("lockTimeout", value ?? DEFAULT_LOCK_TIMEOUT);
  } catch {
    ms = undefined;
  }
  if (ms === undefined || ms > MAX_LOCK_TIMEOUT_MS) {
    throw new IdemfenceConfigError(
      "LOCK_TIMEOUT_INVALID",
      `Option \`lockTimeout\` must be a positive integer number of milliseconds (at most ${MAX_LOCK_TIMEOUT_MS}) or a string such as "250ms" (units: ms, s, m, h, d).`,
    );
  }
  return ms;
}

function routeMode(store: Store, value: unknown): RouteMode {
  const resolved = value ?? "lease";
  if (resolved !== "lease" && resolved !== "transactional") {
    throw new IdemfenceConfigError(
      "ROUTE_MODE_INVALID",
      'Route option `mode` must be "lease" or "transactional".',
    );
  }
  if (
    resolved === "transactional" &&
    typeof (store as Partial<TransactionalStore>).openTransaction !== "function"
  ) {
    throw new IdemfenceConfigError(
      "MODE_UNSUPPORTED",
      'Route option `mode: "transactional"` requires a store with an openTransaction function, such as idemfence/postgres.',
    );
  }
  return resolved;
}

function keyMaxLength(value: unknown): number {
  const resolved = value ?? 255;
  if (
    typeof resolved !== "number" ||
    !Number.isInteger(resolved) ||
    resolved < 1 ||
    resolved > 255
  ) {
    throw new IdemfenceConfigError(
      "KEY_MAX_LENGTH_INVALID",
      "Option `keyMaxLength` must be an integer from 1 to 255.",
    );
  }
  return resolved;
}

function releaseStatuses(value: unknown): readonly number[] {
  const resolved = value ?? [408, 425, 429];
  if (
    !Array.isArray(resolved) ||
    !resolved.every(
      (status) => Number.isInteger(status) && status >= 400 && status <= 599,
    )
  ) {
    throw new IdemfenceConfigError(
      "RELEASE_STATUS_INVALID",
      "Option `releaseStatuses` must contain only integer status codes from 400 to 599; releasing a success or redirect status would let a completed operation run twice.",
    );
  }
  return Object.freeze([...resolved]);
}

function keySyntax(value: unknown): KeySyntax {
  const resolved = value ?? "sf-string";
  if (resolved !== "sf-string" && resolved !== "sf-string-or-raw") {
    throw new IdemfenceConfigError(
      "KEY_SYNTAX_INVALID",
      'Option `keySyntax` must be "sf-string" or "sf-string-or-raw".',
    );
  }
  return resolved;
}

function namespace(value: unknown): string {
  const resolved = value ?? "idemfence";
  if (typeof resolved !== "string" || !NAMESPACE_PATTERN.test(resolved)) {
    throw new IdemfenceConfigError(
      "NAMESPACE_INVALID",
      "Option `namespace` must be 1 to 64 printable ASCII characters (0x21 to 0x7E).",
    );
  }
  return resolved;
}

function headerAllowlist(value: unknown): readonly string[] {
  const names = value ?? [];
  if (!Array.isArray(names)) {
    throw new IdemfenceConfigError(
      "HEADER_ALLOWLIST_INVALID",
      "Option `headerAllowlist` must be an array of HTTP field names.",
    );
  }
  const resolved = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || !FIELD_NAME_PATTERN.test(name)) {
      throw new IdemfenceConfigError(
        "HEADER_ALLOWLIST_INVALID",
        "Option `headerAllowlist` must contain only HTTP field names (RFC 9110 tokens).",
      );
    }
    const lower = name.toLowerCase();
    if (NOT_ALLOWLISTABLE.has(lower)) {
      throw new IdemfenceConfigError(
        "HEADER_ALLOWLIST_INVALID",
        `Option \`headerAllowlist\` must not include "${lower}": content-type is always fingerprinted, and denylisted, volatile or secret-bearing headers cannot be.`,
      );
    }
    resolved.add(lower);
  }
  return Object.freeze([...resolved]);
}

function booleanOption(
  option: string,
  code: "REQUIRED_INVALID" | "ROUTE_FLAG_INVALID",
  value: unknown,
  fallback: boolean,
): boolean {
  const resolved = value ?? fallback;
  if (typeof resolved !== "boolean") {
    throw new IdemfenceConfigError(
      code,
      `Option \`${option}\` must be a boolean.`,
    );
  }
  return resolved;
}

function logger(value: unknown): Logger {
  const resolved = value ?? defaultLogger;
  if (
    typeof resolved !== "object" ||
    resolved === null ||
    typeof (resolved as Logger).warn !== "function" ||
    typeof (resolved as Logger).error !== "function"
  ) {
    throw new IdemfenceConfigError(
      "LOGGER_INVALID",
      "Option `logger` must be an object with warn and error functions.",
    );
  }
  return resolved as Logger;
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
