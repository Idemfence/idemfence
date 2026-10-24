import type { ResolvedConfig } from "./config.js";

/** Problem types defined in docs/contract.md section 6; each is an anchor in that document. */
export type ProblemKind =
  | "key-missing"
  | "key-malformed"
  | "key-reused"
  | "in-flight"
  | "store-unavailable"
  | "body-too-large"
  | "configuration-error";

type ProblemConfig = Pick<
  ResolvedConfig,
  "docsUrl" | "storeUnavailableRetryAfter"
>;

// Titles are normative (docs/contract.md section 6); detail wording is not.
const PROBLEMS: Record<
  ProblemKind,
  { status: number; title: string; detail: string }
> = {
  "key-missing": {
    status: 400,
    title: "Idempotency-Key is missing",
    detail: "This operation requires an Idempotency-Key header.",
  },
  "key-malformed": {
    status: 400,
    title: "Idempotency-Key is malformed",
    detail:
      "The Idempotency-Key header must be a single Structured Field String of printable ASCII characters, within the length limit.",
  },
  "key-reused": {
    status: 422,
    title: "Idempotency-Key is already used",
    detail: "This Idempotency-Key was already used with a different request.",
  },
  "in-flight": {
    status: 409,
    title: "A request is outstanding for this Idempotency-Key",
    detail:
      "A request with the same Idempotency-Key is still being processed. Retry after the number of seconds in Retry-After.",
  },
  "store-unavailable": {
    status: 503,
    title: "Idempotency store is unavailable",
    detail:
      "The idempotency store is unavailable. Retry after the number of seconds in Retry-After.",
  },
  "body-too-large": {
    status: 413,
    title: "Request body is too large",
    detail:
      "The request body exceeds the size limit for idempotent requests on this route.",
  },
  "configuration-error": {
    status: 500,
    title: "Idempotency middleware is misconfigured",
    detail:
      "The server's idempotency configuration is invalid; the request was not processed.",
  },
};

/**
 * Builds the RFC 9457 problem response for `kind`. `in-flight` requires the remaining lease
 * (or lock timeout) in milliseconds; `store-unavailable` defaults to the configured delay.
 * The response never contains the client's key.
 */
export function problemResponse(
  kind: "in-flight",
  config: ProblemConfig,
  extra: { retryAfterMs: number },
): Response;
export function problemResponse(
  kind: Exclude<ProblemKind, "in-flight">,
  config: ProblemConfig,
  extra?: { retryAfterMs?: number },
): Response;
export function problemResponse(
  kind: ProblemKind,
  config: ProblemConfig,
  extra?: { retryAfterMs?: number },
): Response {
  const { status, title, detail } = PROBLEMS[kind];
  const type = problemType(config.docsUrl, kind);
  const headers = new Headers({
    "content-type": "application/problem+json",
    link: `<${type}>; rel="describedby"`,
  });

  let retryAfterMs: number | undefined;
  if (kind === "in-flight") {
    retryAfterMs = extra?.retryAfterMs;
    if (retryAfterMs === undefined) {
      throw new TypeError(
        "An in-flight problem response requires retryAfterMs.",
      );
    }
  } else if (kind === "store-unavailable") {
    retryAfterMs = extra?.retryAfterMs ?? config.storeUnavailableRetryAfter;
  }
  if (retryAfterMs !== undefined) {
    headers.set("retry-after", String(retryAfterSeconds(retryAfterMs)));
  }

  return new Response(JSON.stringify({ type, title, status, detail }), {
    status,
    headers,
  });
}

/** Retry-After delay-seconds: whole seconds, rounded up, minimum 1 (docs/contract.md section 6). */
export function retryAfterSeconds(ms: number): number {
  if (!Number.isFinite(ms)) {
    throw new RangeError(
      "Retry-After must be computed from a finite number of milliseconds.",
    );
  }
  return Math.max(1, Math.ceil(ms / 1_000));
}

function problemType(docsUrl: string, kind: ProblemKind): string {
  const url = new URL(docsUrl);
  url.hash = kind;
  return url.href;
}
