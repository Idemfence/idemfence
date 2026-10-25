import {
  type LogFields,
  type ResolvedConfig,
  type ResolvedRoute,
  type RouteConfig,
  resolveRoute,
} from "./config.js";
import { fingerprint, lookupKey } from "./hash.js";
import { parseIdempotencyKey } from "./key.js";
import {
  internalProblemResponse,
  type ProblemKind,
  problemResponse,
} from "./problem.js";
import {
  IdemfenceStoreError,
  type SqlExecutor,
  type StoredResponse,
  type TransactionalStore,
} from "./store.js";

/** Thrown by `ctx.renew()` when another attempt has taken the lease over (contract row 9). */
export class IdemfenceFencedError extends Error {
  readonly code = "FENCED";

  constructor() {
    super(
      "Another attempt took over the lease for this request; its result will not be stored.",
    );
    this.name = "IdemfenceFencedError";
  }
}

export interface HandlerContext {
  /** Extends the lease; rejects with {@link IdemfenceFencedError} once fenced. */
  renew(): Promise<void>;
  /**
   * In a route with `mode: "transactional"`, the handler's transaction: every query on it
   * commits when the handler returns and rolls back when it throws. Absent in lease mode.
   */
  readonly tx?: SqlExecutor;
}

export type Handler = (
  request: Request,
  ctx: HandlerContext,
) => Promise<Response>;

export interface Engine {
  /** Verifies the store once (memoised on success); rejects with the store's error. */
  ready(): Promise<void>;
  /**
   * Applies the contract to one request on a configured route. The route object is
   * validated on first use and cached by identity.
   */
  handle(
    request: Request,
    route: RouteConfig,
    handler: Handler,
  ): Promise<Response>;
}

const COMPLETE_ATTEMPTS = 3;
// Bounded backoff between complete attempts: 400 ms in total (contract section 5).
const COMPLETE_BACKOFF_MS = [100, 300] as const;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
// Contract section 5: never stored or replayed. Set-Cookie is handled per route.
const HEADER_DENYLIST = new Set([
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
]);

// Responses the engine generated for row 15, so an adapter can close the connection without
// inspecting headers; a handler's own 413 is never in this set.
const bodyTooLargeResponses = new WeakSet<Response>();

/** True only for a 413 the engine itself produced for contract row 15. */
export function isBodyTooLargeResponse(response: Response): boolean {
  return bodyTooLargeResponses.has(response);
}

type HandlerOutcome =
  | { kind: "response"; response: Response }
  | { kind: "threw"; error: unknown }
  /** Transactional mode only: the transaction could not be opened or committed. */
  | { kind: "unavailable"; error: unknown };

const passthroughContext: HandlerContext = {
  async renew() {},
};

export function createEngine(config: ResolvedConfig<Request>): Engine {
  const { store, logger } = config;
  const routes = new WeakMap<RouteConfig, ResolvedRoute>();
  let ready: Promise<void> | undefined;

  function resolved(route: RouteConfig): ResolvedRoute {
    let result = routes.get(route);
    if (result === undefined) {
      result = resolveRoute(config, route);
      routes.set(route, result);
    }
    return result;
  }

  // ready() runs once; a failure is not cached, so a later request can retry it.
  function ensureReady(): Promise<void> {
    ready ??= store.ready().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  }

  function problem(
    route: ResolvedRoute,
    kind: Exclude<ProblemKind, "in-flight">,
    extra?: { retryAfterMs?: number },
  ): Response {
    return problemResponse(
      kind,
      {
        docsUrl: config.docsUrl,
        storeUnavailableRetryAfter: route.storeUnavailableRetryAfter,
      },
      extra,
    );
  }

  async function handle(
    request: Request,
    routeConfig: RouteConfig,
    handler: Handler,
  ): Promise<Response> {
    const route = resolved(routeConfig);

    // Rows 2 and 3.
    const parsed = parseIdempotencyKey(request.headers, route);
    if ("error" in parsed) {
      return problem(route, parsed.error);
    }
    // Optional-key route without a key: handled as row 1.
    if (parsed.key === undefined) {
      return handler(request, passthroughContext);
    }

    // Row 4, fail closed: a scope that throws, or returns anything but a non-empty
    // string, leaves the request unprocessed.
    let principal: unknown;
    let scopeError: unknown;
    try {
      principal = config.scope(request);
    } catch (error) {
      scopeError = error;
    }
    if (typeof principal !== "string" || principal === "") {
      logger.error(
        "idemfence: scope returned no principal; request not processed",
        {
          row: 4,
          outcome: "configuration-error",
          ...(scopeError === undefined ? {} : { error: errorInfo(scopeError) }),
        },
      );
      return problem(route, "configuration-error");
    }

    // Row 15.
    const printed = await fingerprint(request, route);
    if ("error" in printed) {
      const response = problem(route, "body-too-large");
      bodyTooLargeResponses.add(response);
      return response;
    }

    const key = await lookupKey({
      namespace: config.namespace,
      principal,
      method: request.method,
      routeTemplate: route.routeTemplate,
      clientKey: parsed.key,
    });
    const keyHash = hashPrefix(key);

    // Row 14.
    let begun: Awaited<ReturnType<typeof store.begin>>;
    try {
      await ensureReady();
      begun = await store.begin(
        key,
        printed.fingerprint,
        config.lease,
        config.retention,
      );
    } catch (error) {
      if (route.failOpen) {
        logger.warn(
          "idemfence: store unavailable; running handler without idempotency (fail-open)",
          {
            keyHash,
            row: 14,
            outcome: "fail-open",
            error: errorInfo(error),
          },
        );
        return handler(request, passthroughContext);
      }
      logger.error("idemfence: store unavailable", {
        keyHash,
        row: 14,
        outcome: "store-unavailable",
        error: errorInfo(error),
      });
      return problem(route, "store-unavailable");
    }

    switch (begun.outcome) {
      case "replay":
        return replay(begun.response);
      case "mismatch":
        return problem(route, "key-reused");
      case "in_flight":
        return problemResponse(
          "in-flight",
          {
            docsUrl: config.docsUrl,
            storeUnavailableRetryAfter: route.storeUnavailableRetryAfter,
          },
          { retryAfterMs: begun.retryAfterMs },
        );
      case "acquired":
        return run(
          request,
          route,
          handler,
          key,
          keyHash,
          begun.fencingToken,
          begun.attempts,
        );
    }
  }

  async function run(
    request: Request,
    route: ResolvedRoute,
    handler: Handler,
    key: Uint8Array,
    keyHash: string,
    fencingToken: bigint,
    attempts: number,
  ): Promise<Response> {
    const row = attempts > 1 ? 9 : 5;
    const ctx: HandlerContext = {
      async renew() {
        if ((await store.renew(key, fencingToken, config.lease)) === "fenced") {
          throw new IdemfenceFencedError();
        }
      },
    };

    let outcome: HandlerOutcome;
    if (route.mode === "transactional") {
      // The handler runs inside one store transaction and sees it as ctx.tx; a throw rolls
      // its writes back. Writing the record inside that transaction (contract rows 11 and
      // 13) is not implemented yet: the record still follows lease mode.
      outcome = await inTransaction(request, handler, ctx);
      if (outcome.kind === "unavailable") {
        // Row 14, both ways a 503 with Retry-After rather than a stored 500, which would be
        // replayed for an operation that never ran.
        if (isCommitUnknown(outcome.error)) {
          // The connection failed during COMMIT with no answer from the server: the
          // handler's writes may or may not have landed. The lease is kept so a retry
          // waits (row 8) until it expires; the record lives outside the transaction until
          // 2.2 moves it inside, which resolves this ambiguity.
          logger.error(
            "idemfence: connection failed during COMMIT; outcome unknown, lease kept",
            {
              keyHash,
              row: 14,
              outcome: "commit-unknown",
              error: errorInfo(outcome.error),
            },
          );
          return problem(route, "store-unavailable");
        }
        // The transaction could not be opened, or the server rejected COMMIT: the
        // handler's work never happened, so the key is freed for a retry.
        logger.error(
          "idemfence: transaction could not be opened or committed; nothing was applied",
          {
            keyHash,
            row: 14,
            outcome: "store-unavailable",
            error: errorInfo(outcome.error),
          },
        );
        await releaseLease(key, fencingToken, keyHash, 14);
        return problem(route, "store-unavailable");
      }
    } else {
      try {
        outcome = { kind: "response", response: await handler(request, ctx) };
      } catch (error) {
        outcome = { kind: "threw", error };
      }
    }

    let response: Response;
    const threw = outcome.kind === "threw";
    if (outcome.kind === "threw") {
      // Row 12: side effects may have happened, so the failure is stored and replayed.
      logger.error("idemfence: handler threw; storing a 500 problem", {
        keyHash,
        row: 12,
        outcome: "handler-error",
        error: errorInfo(outcome.error),
      });
      response = internalProblemResponse();
    } else {
      response = outcome.response;
    }

    // Row 11 applies only to a response the handler returned: a throw is always stored
    // (row 12), even when 500 is a release status.
    if (!threw && route.releaseStatuses.includes(response.status)) {
      await releaseLease(key, fencingToken, keyHash, 11);
      return response;
    }

    // Rows 5, 9 and 12: store-then-send.
    const captured = await capture(response, route, keyHash);
    const completed = await completeWithRetries(
      key,
      fencingToken,
      captured.stored,
      keyHash,
      row,
    );
    if (completed === "fenced") {
      logger.warn(
        "idemfence: complete was fenced; sending the handler's response unstored",
        {
          keyHash,
          row: 9,
          outcome: "fenced",
        },
      );
    }
    return captured.send;
  }

  /**
   * Runs the handler inside the store's transaction. The handler's own throw is recorded
   * before it propagates, so anything else escaping `transaction()` is the store failing to
   * open or commit it.
   */
  async function inTransaction(
    request: Request,
    handler: Handler,
    ctx: HandlerContext,
  ): Promise<HandlerOutcome> {
    let threw: { error: unknown } | undefined;
    try {
      const response = await (store as TransactionalStore).transaction(
        async (tx) => {
          try {
            return await handler(request, { ...ctx, tx });
          } catch (error) {
            threw = { error };
            throw error;
          }
        },
      );
      return { kind: "response", response };
    } catch (error) {
      return threw === undefined
        ? { kind: "unavailable", error }
        : { kind: "threw", error: threw.error };
    }
  }

  /** Deletes the in-flight record so the key can be retried; a failure only logs. */
  async function releaseLease(
    key: Uint8Array,
    fencingToken: bigint,
    keyHash: string,
    row: number,
  ): Promise<void> {
    try {
      if ((await store.release(key, fencingToken)) === "fenced") {
        logger.warn("idemfence: release was fenced", {
          keyHash,
          row: 9,
          outcome: "fenced",
        });
      }
    } catch (error) {
      logger.error(
        "idemfence: release failed; the lease will expire on its own",
        {
          keyHash,
          row,
          outcome: "store_error",
          error: errorInfo(error),
        },
      );
    }
  }

  async function completeWithRetries(
    key: Uint8Array,
    fencingToken: bigint,
    stored: StoredResponse,
    keyHash: string,
    row: number,
  ): Promise<"completed" | "fenced" | "failed"> {
    for (let attempt = 1; attempt <= COMPLETE_ATTEMPTS; attempt += 1) {
      try {
        return await store.complete(key, fencingToken, stored);
      } catch (error) {
        const fields: LogFields = {
          keyHash,
          row,
          outcome:
            attempt < COMPLETE_ATTEMPTS ? "complete-retry" : "store_error",
          attempt,
          error: errorInfo(error),
        };
        if (attempt < COMPLETE_ATTEMPTS) {
          logger.warn("idemfence: complete failed; retrying", fields);
          await sleep(COMPLETE_BACKOFF_MS[attempt - 1] ?? 0);
        } else {
          logger.error(
            "idemfence: complete failed; sending the handler's response unstored",
            fields,
          );
        }
      }
    }
    return "failed";
  }

  /**
   * Buffers the handler's response up to the route's cap. Over the cap, the record is
   * completed without a body and the client still receives every byte: the buffered prefix
   * followed by the rest of the stream, with memory bounded by the cap.
   */
  async function capture(
    handlerResponse: Response,
    route: ResolvedRoute,
    keyHash: string,
  ): Promise<{ stored: StoredResponse; send: Response }> {
    let response = handlerResponse;
    if (
      /^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")
    ) {
      logger.error(
        "idemfence: streaming (text/event-stream) responses are not supported on idempotent routes; storing a 500 problem",
        { keyHash, row: 12, outcome: "streaming-rejected" },
      );
      response = internalProblemResponse(
        "Streaming responses are not supported on idempotent routes.",
      );
    }

    const { status, statusText } = response;
    const headers = storedHeaders(response.headers, route.allowSetCookieReplay);
    if (response.body === null) {
      return {
        stored: {
          status,
          headers,
          body: new Uint8Array(0),
          bodyOmitted: false,
        },
        send: response,
      };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const body = concat(chunks, total);
        return {
          stored: { status, headers, body, bodyOmitted: false },
          send: new Response(body, {
            status,
            statusText,
            headers: response.headers,
          }),
        };
      }
      chunks.push(value);
      total += value.byteLength;
      if (total > route.responseBodyCap) {
        logger.error(
          "idemfence: response body exceeds responseBodyCap; record completed without the body",
          { keyHash, row: 12, outcome: "body-omitted" },
        );
        const rest = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }
          },
          async pull(controller) {
            const next = await reader.read();
            if (next.done) {
              controller.close();
            } else {
              controller.enqueue(next.value);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
        return {
          stored: { status, headers, body: null, bodyOmitted: true },
          send: new Response(rest, {
            status,
            statusText,
            headers: response.headers,
          }),
        };
      }
    }
  }

  return { ready: ensureReady, handle };
}

/** Row 6: the stored response with the replay headers and a recomputed Content-Length. */
function replay(stored: StoredResponse): Response {
  const headers = new Headers();
  for (const [name, value] of stored.headers) {
    headers.append(name, value);
  }
  const body =
    stored.bodyOmitted || stored.body === null
      ? new Uint8Array(0)
      : new Uint8Array(stored.body);
  headers.set("content-length", String(body.byteLength));
  headers.set("idempotent-replayed", "true");
  if (stored.bodyOmitted) {
    headers.set("idempotent-body-omitted", "true");
  }
  return new Response(NULL_BODY_STATUSES.has(stored.status) ? null : body, {
    status: stored.status,
    headers,
  });
}

function storedHeaders(
  headers: Headers,
  allowSetCookie: boolean,
): readonly (readonly [string, string])[] {
  const connectionNamed = new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ""),
  );
  const pairs: [string, string][] = [];
  // Headers iteration yields lowercase names and one entry per Set-Cookie.
  for (const [name, value] of headers) {
    if (HEADER_DENYLIST.has(name) || connectionNamed.has(name)) {
      continue;
    }
    if (name === "set-cookie" && !allowSetCookie) {
      continue;
    }
    pairs.push([name, value]);
  }
  return pairs;
}

function concat(
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isCommitUnknown(error: unknown): boolean {
  return (
    error instanceof IdemfenceStoreError && error.code === "COMMIT_UNKNOWN"
  );
}

function hashPrefix(key: Uint8Array): string {
  return Array.from(key.subarray(0, 4), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function errorInfo(error: unknown): { name: string; code?: string } {
  const name = error instanceof Error ? error.name : "Error";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? { name, code } : { name };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
