import {
  type LogFields,
  type ResolvedConfig,
  type ResolvedRoute,
  type RouteConfig,
  resolveRoute,
} from "./config.js";
import { derivedKey, deriveHmacKey, fingerprint, lookupKey } from "./hash.js";
import { parseIdempotencyKey } from "./key.js";
import {
  internalProblemResponse,
  type ProblemKind,
  problemResponse,
} from "./problem.js";
import type {
  BeginResult,
  SqlExecutor,
  StoredResponse,
  StoreTransaction,
  TransactionalStore,
} from "./store.js";

/**
 * Another attempt took the lease over (contract row 9): thrown by `ctx.renew()`, and the
 * reason `ctx.signal` aborts with when a renewal (heartbeat or manual) is fenced.
 */
export class IdemfenceFencedError extends Error {
  readonly code = "FENCED";

  constructor() {
    super(
      "Another attempt took over the lease for this request; its result will not be stored.",
    );
    this.name = "IdemfenceFencedError";
  }
}

/**
 * The handler held its lease for `maxHold`: the reason `ctx.signal` aborts with, and what
 * `ctx.renew()` rejects with from then on. The lease is no longer renewed and expires on the
 * store's clock.
 */
export class IdemfenceHoldLimitError extends Error {
  readonly code = "HOLD_LIMIT";

  constructor() {
    super(
      "The handler held its lease for maxHold; the lease is no longer renewed and will expire.",
    );
    this.name = "IdemfenceHoldLimitError";
  }
}

/**
 * Stable codes for {@link IdemfenceDeriveError}:
 *
 * - `DERIVE_LABEL_INVALID`: the label passed to `ctx.deriveKey` is not a string of 1 to 128
 *   printable ASCII characters (0x21 to 0x7E, so no spaces).
 * - `DERIVE_KEY_UNAVAILABLE`: `ctx.deriveKey` was called on a request without an
 *   `Idempotency-Key` (an optional-key route, or a method the adapter does not enforce),
 *   so there is no lookup key to derive from.
 */
export type IdemfenceDeriveErrorCode =
  | "DERIVE_LABEL_INVALID"
  | "DERIVE_KEY_UNAVAILABLE";

/** Rejection of `ctx.deriveKey` (docs/contract.md section 5, derived downstream keys). */
export class IdemfenceDeriveError extends Error {
  readonly code: IdemfenceDeriveErrorCode;

  constructor(code: IdemfenceDeriveErrorCode, message: string) {
    super(message);
    this.name = "IdemfenceDeriveError";
    this.code = code;
  }
}

/**
 * Derives a downstream idempotency key for a call this request makes to another service,
 * such as a payment provider (docs/contract.md section 5). The key depends only on the
 * request's lookup key, its fingerprint, the label and the oldest configured secret, so
 * every attempt of the same request (a retry after a throw or a release, a lease takeover,
 * a fail-open run) derives the same value, and a reused key with a different payload
 * derives a different one. Resolves to 64 lowercase hex characters.
 *
 * `label` names the downstream call and must be 1 to 128 printable ASCII characters
 * (0x21 to 0x7E); anything else rejects with {@link IdemfenceDeriveError} code
 * `DERIVE_LABEL_INVALID`. On a request without an `Idempotency-Key` it rejects with code
 * `DERIVE_KEY_UNAVAILABLE`.
 */
export type DeriveKey = (label: string) => Promise<string>;

/**
 * `ctx.signal`: aborts when this attempt has lost, or will lose, its lease, so the handler
 * can stop downstream work (pass it to `fetch` and the like). It aborts only in lease mode
 * while a lease is held: with {@link IdemfenceFencedError} when a renewal (heartbeat or
 * `ctx.renew()`) finds that another attempt took the lease over, or with
 * {@link IdemfenceHoldLimitError} once the lease has been held for `maxHold`. In
 * transactional mode, on a fail-open run, and on a request idemfence does not apply to, it
 * never aborts. It is not the request's signal and is not linked to it: a client that
 * disconnects does not abort it (contract row 16). Aborting it interrupts nothing by itself.
 */
export type HandlerSignal = AbortSignal;

/** The handler's context in lease mode (the default). */
export interface LeaseHandlerContext {
  /**
   * Extends the lease. With the heartbeat on (the default) there is no need to call it.
   * Rejects with {@link IdemfenceFencedError} once fenced (and aborts `signal` first), and
   * with {@link IdemfenceHoldLimitError} once the lease has been held for `maxHold`.
   */
  renew(): Promise<void>;
  /** See {@link DeriveKey}. */
  readonly deriveKey: DeriveKey;
  /** See {@link HandlerSignal}. */
  readonly signal: HandlerSignal;
  /** Absent in lease mode. */
  readonly tx?: undefined;
}

/**
 * The handler's context in a route with `mode: "transactional"`. The transaction is the
 * lease, so there is no `renew`: a lease update inside the uncommitted transaction would be
 * invisible to other sessions and would row-lock the record.
 */
export interface TransactionalHandlerContext {
  /** Absent in transactional mode. */
  readonly renew?: undefined;
  /**
   * The handler's transaction, which also holds the idempotency record (docs/contract.md
   * section 7). What the handler writes through it commits together with the stored
   * response, and rolls back together with the record when the handler throws (row 13) or
   * returns a release status (row 11). On a request without a key (optional-key route) it
   * is a plain transaction with no record: committed when the handler resolves, rolled back
   * when it throws.
   *
   * - Never run `BEGIN`, `COMMIT` or `ROLLBACK` on it: idemfence ends the transaction after
   *   storing the response. `SAVEPOINT`, `RELEASE SAVEPOINT` and `ROLLBACK TO SAVEPOINT`
   *   are fine.
   * - A failed statement aborts the whole transaction, even when the handler catches the
   *   error; the request is then answered 503 store-unavailable and nothing is committed.
   *   Use a savepoint around a statement that may fail.
   * - It is dead once the transaction ends: a query after the handler's response has been
   *   committed or rolled back rejects at once with `IdemfenceStoreError` code
   *   `TRANSACTION_ENDED`. Finish every query before returning: a response body that
   *   streams after `COMMIT` (over `responseBodyCap`, or any body on a request without a
   *   key) must not read from `ctx.tx`.
   */
  readonly tx: SqlExecutor;
  /** See {@link DeriveKey}. */
  readonly deriveKey: DeriveKey;
  /** See {@link HandlerSignal}: there is no lease in this mode, so it never aborts. */
  readonly signal: HandlerSignal;
}

export type HandlerContext = LeaseHandlerContext | TransactionalHandlerContext;

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
  /** See `Idemfence.passthrough`. */
  passthrough(
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
  | { kind: "threw"; error: unknown };

const DERIVE_LABEL = /^[\x21-\x7e]{1,128}$/;

function checkLabel(label: unknown): void {
  if (typeof label !== "string" || !DERIVE_LABEL.test(label)) {
    throw new IdemfenceDeriveError(
      "DERIVE_LABEL_INVALID",
      "ctx.deriveKey: `label` must be 1 to 128 printable ASCII characters (0x21 to 0x7E).",
    );
  }
}

/**
 * `deriveKey` on a request without an `Idempotency-Key`. A bad label is still reported as
 * such, so the bug shows on every request.
 */
const deriveUnavailable: DeriveKey = async (label) => {
  checkLabel(label);
  throw new IdemfenceDeriveError(
    "DERIVE_KEY_UNAVAILABLE",
    "ctx.deriveKey: this request has no Idempotency-Key, so there is no key to derive from.",
  );
};

/**
 * A signal for a context that holds no lease: nothing can abort it. One per request, so the
 * listeners a handler adds (`fetch` adds one per call) never pile up on a shared signal.
 */
function quietSignal(): AbortSignal {
  return new AbortController().signal;
}

/**
 * The lease-mode context for a request idemfence does not apply to (no key on an
 * optional-key route, or a method the adapter does not enforce).
 */
function passthroughContext(): LeaseHandlerContext {
  return {
    async renew() {},
    deriveKey: deriveUnavailable,
    signal: quietSignal(),
  };
}

// The row each non-acquired begin outcome answers, for logs.
const NOT_ACQUIRED_ROWS = { replay: 6, mismatch: 7, in_flight: 8 } as const;

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

  // The HMAC key for derived keys is imported once, from the oldest secret (the last entry
  // of previousSecrets, which is newest first): rotating a new secret in moves the old one
  // to the front of previousSecrets and changes no derived key.
  // The fingerprint is the one already computed for the request (row 15), so a reused key
  // with a different payload derives a different key.
  let hmacKey: Promise<CryptoKey> | undefined;
  function deriveFor(
    lookup: Uint8Array,
    requestFingerprint: Uint8Array,
  ): DeriveKey {
    return async (label) => {
      checkLabel(label);
      hmacKey ??= deriveHmacKey(
        config.previousSecrets.at(-1) ?? config.secret,
      ).catch((error: unknown) => {
        hmacKey = undefined;
        throw error;
      });
      return derivedKey(await hmacKey, lookup, requestFingerprint, label);
    };
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
    // Optional-key route without a key: handled as row 1. A transactional handler still
    // gets ctx.tx, in a transaction with no record.
    if (parsed.key === undefined) {
      return unapplied(request, route.mode, handler);
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

    if (route.mode === "transactional") {
      return transactional(
        request,
        route,
        handler,
        key,
        printed.fingerprint,
        keyHash,
      );
    }

    // Row 14.
    let begun: BeginResult;
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
        // The lookup key is known, so downstream calls still deduplicate.
        return handler(request, {
          async renew() {},
          deriveKey: deriveFor(key, printed.fingerprint),
          // No lease is held, so nothing ever aborts it.
          signal: quietSignal(),
        });
      }
      return storeUnavailable(
        route,
        keyHash,
        "idemfence: store unavailable",
        error,
      );
    }

    if (begun.outcome !== "acquired") {
      return notAcquired(route, begun);
    }
    return run(
      request,
      route,
      handler,
      key,
      keyHash,
      begun.fencingToken,
      begun.attempts,
      deriveFor(key, printed.fingerprint),
    );
  }

  /** Rows 6, 7 and 8: the response for a key this request could not claim. */
  function notAcquired(
    route: ResolvedRoute,
    begun: Exclude<BeginResult, { outcome: "acquired" }>,
  ): Response {
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
    }
  }

  /** Row 14 and the transactional-mode 503 of section 5: logged, fail closed. */
  function storeUnavailable(
    route: ResolvedRoute,
    keyHash: string,
    message: string,
    error: unknown,
  ): Response {
    logger.error(message, {
      keyHash,
      row: 14,
      outcome: "store-unavailable",
      error: errorInfo(error),
    });
    return problem(route, "store-unavailable");
  }

  /**
   * Transactional mode (contract section 7). One transaction on one connection holds the
   * record and the handler's writes, so they commit or roll back together, and the response
   * is sent only once COMMIT has succeeded. While it is open no second connection is taken:
   * on a saturated pool that would deadlock. There is no renew: the transaction is the lease.
   */
  async function transactional(
    request: Request,
    route: ResolvedRoute,
    handler: Handler,
    key: Uint8Array,
    requestFingerprint: Uint8Array,
    keyHash: string,
  ): Promise<Response> {
    const txStore = store as TransactionalStore;

    // Row 14.
    let transaction: StoreTransaction;
    try {
      await ensureReady();
      transaction = await txStore.openTransaction();
    } catch (error) {
      return storeUnavailable(
        route,
        keyHash,
        "idemfence: store unavailable",
        error,
      );
    }
    let begun: BeginResult;
    try {
      // A concurrent request holding the key makes begin wait, up to the store's lock
      // timeout, on its uncommitted record.
      begun = await txStore.begin(
        key,
        requestFingerprint,
        config.lease,
        config.retention,
        transaction.executor,
      );
    } catch (error) {
      await rollback(transaction, keyHash, 14);
      return storeUnavailable(
        route,
        keyHash,
        "idemfence: store unavailable",
        error,
      );
    }
    if (begun.outcome !== "acquired") {
      // Nothing was written (and a lock timeout left the transaction aborted).
      await rollback(transaction, keyHash, NOT_ACQUIRED_ROWS[begun.outcome]);
      return notAcquired(route, begun);
    }

    // Row 13: the record rolls back with the handler's writes, so the key is free and a
    // retry runs the handler again. A response body that fails while it is read counts as
    // the handler throwing.
    const threw = async (error: unknown): Promise<Response> => {
      await rollback(transaction, keyHash, 13);
      logger.error(
        "idemfence: handler threw; its writes and the record were rolled back, nothing stored",
        {
          keyHash,
          row: 13,
          outcome: "handler-error",
          error: errorInfo(error),
        },
      );
      return internalProblemResponse();
    };

    let response: Response;
    try {
      response = await handler(request, {
        tx: transaction.executor,
        deriveKey: deriveFor(key, requestFingerprint),
        signal: quietSignal(),
      });
    } catch (error) {
      return threw(error);
    }

    // Row 11: the handler's writes and the record roll back together; the key is free.
    if (route.releaseStatuses.includes(response.status)) {
      await rollback(transaction, keyHash, 11);
      return response;
    }

    // Rows 5, 10 and 12: store-then-send, with the record completed inside the transaction.
    let captured: Awaited<ReturnType<typeof capture>>;
    try {
      captured = await capture(response, route, keyHash);
    } catch (error) {
      return threw(error);
    }
    let completed: "completed" | "fenced";
    try {
      // Once, without retries: a failed statement aborts the transaction.
      completed = await txStore.complete(
        key,
        begun.fencingToken,
        captured.stored,
        transaction.executor,
      );
    } catch (error) {
      // Also the path for a transaction the handler left aborted (it caught a failed
      // statement). None of the handler's work was committed, so its response is not sent.
      cancelBody(captured.send);
      await rollback(transaction, keyHash, 14);
      return storeUnavailable(
        route,
        keyHash,
        "idemfence: the record could not be completed in the handler's transaction; rolled back",
        error,
      );
    }
    if (completed === "fenced") {
      cancelBody(captured.send);
      await rollback(transaction, keyHash, 14);
      logger.error(
        "idemfence: invariant violated: complete was fenced inside the transaction that holds the record's row lock; rolled back",
        { keyHash, row: 14, outcome: "fenced" },
      );
      return problem(route, "store-unavailable");
    }
    try {
      await transaction.commit();
    } catch (error) {
      // COMMIT_REJECTED rolled everything back. After COMMIT_UNKNOWN the record and the
      // handler's writes either both landed (a retry replays) or neither did (a retry runs
      // the handler); there is nothing to release either way.
      cancelBody(captured.send);
      return storeUnavailable(
        route,
        keyHash,
        "idemfence: COMMIT of the handler's transaction failed",
        error,
      );
    }
    return captured.send;
  }

  /**
   * An optional-key transactional route without a key (row 1): the handler runs in a plain
   * transaction with no record, committed when it resolves and rolled back when it throws.
   * Failures to open or commit reject, as the handler's own database errors would.
   */
  async function plainTransaction(
    request: Request,
    handler: Handler,
  ): Promise<Response> {
    const transaction = await (store as TransactionalStore).openTransaction();
    let response: Response;
    try {
      response = await handler(request, {
        tx: transaction.executor,
        deriveKey: deriveUnavailable,
        signal: quietSignal(),
      });
    } catch (error) {
      await rollback(transaction, undefined, 1);
      throw error;
    }
    try {
      await transaction.commit();
    } catch (error) {
      cancelBody(response);
      throw error;
    }
    return response;
  }

  /**
   * Ends a transaction that must not commit. A failed ROLLBACK destroys the connection,
   * which commits nothing either, so it only logs and never changes the response.
   */
  async function rollback(
    transaction: StoreTransaction,
    keyHash: string | undefined,
    row: number,
  ): Promise<void> {
    try {
      await transaction.rollback();
    } catch (error) {
      logger.error(
        "idemfence: ROLLBACK failed; the connection was destroyed and nothing was committed",
        {
          ...(keyHash === undefined ? {} : { keyHash }),
          row,
          outcome: "rollback-failed",
          error: errorInfo(error),
        },
      );
    }
  }

  /**
   * Keeps a lease-mode lease while the handler runs (contract section 7). With the heartbeat
   * on, renews every lease / 3 on the store's own connections, each renewal scheduled only
   * after the previous one settled. A fenced renewal (heartbeat or manual) aborts `signal`
   * with IdemfenceFencedError and stops the heartbeat; a failed one is retried at the next
   * interval. After maxHold, on this process's monotonic clock, the heartbeat stops, `signal`
   * aborts with IdemfenceHoldLimitError and `renew` refuses, so the lease expires on the
   * store's clock and the key is held at most maxHold + lease. `settle()` stops everything
   * and waits for a renewal in flight.
   */
  function holdLease(
    key: Uint8Array,
    fencingToken: bigint,
    keyHash: string,
    heartbeat: boolean,
  ): {
    signal: AbortSignal;
    renew: () => Promise<void>;
    settle: () => Promise<void>;
  } {
    const controller = new AbortController();
    let stopped = false;
    let holdLimitReached = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | undefined;

    const stopHeartbeat = () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const lost = (reason: Error) => {
      stopHeartbeat();
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    };

    const beat = async () => {
      try {
        if ((await store.renew(key, fencingToken, config.lease)) === "fenced") {
          logger.warn(
            "idemfence: lease renewal was fenced; ctx.signal aborted",
            { keyHash, row: 9, outcome: "fenced" },
          );
          lost(new IdemfenceFencedError());
        }
      } catch (error) {
        logger.warn(
          "idemfence: lease renewal failed; retrying at the next interval",
          { keyHash, row: 9, outcome: "renew-failed", error: errorInfo(error) },
        );
      }
    };
    const schedule = () => {
      if (stopped) {
        return;
      }
      timer = setTimeout(
        () => {
          timer = undefined;
          if (stopped) {
            return;
          }
          inFlight = beat().finally(() => {
            inFlight = undefined;
            schedule();
          });
        },
        Math.max(1, Math.floor(config.lease / 3)),
      );
      timer.unref();
    };

    const holdTimer = setTimeout(() => {
      holdLimitReached = true;
      if (controller.signal.aborted) {
        return;
      }
      logger.warn(
        "idemfence: lease held for maxHold; heartbeat stopped, ctx.signal aborted",
        { keyHash, row: 9, outcome: "hold-limit" },
      );
      lost(new IdemfenceHoldLimitError());
    }, config.maxHold);
    holdTimer.unref();

    if (heartbeat) {
      schedule();
    }

    return {
      signal: controller.signal,
      async renew() {
        if (holdLimitReached) {
          throw new IdemfenceHoldLimitError();
        }
        if ((await store.renew(key, fencingToken, config.lease)) === "fenced") {
          lost(new IdemfenceFencedError());
          throw new IdemfenceFencedError();
        }
      },
      async settle() {
        stopHeartbeat();
        clearTimeout(holdTimer);
        while (inFlight !== undefined) {
          await inFlight;
        }
      },
    };
  }

  async function run(
    request: Request,
    route: ResolvedRoute,
    handler: Handler,
    key: Uint8Array,
    keyHash: string,
    fencingToken: bigint,
    attempts: number,
    deriveKey: DeriveKey,
  ): Promise<Response> {
    const row = attempts > 1 ? 9 : 5;
    const lease = holdLease(key, fencingToken, keyHash, route.heartbeat);
    const ctx: LeaseHandlerContext = {
      renew: lease.renew,
      deriveKey,
      signal: lease.signal,
    };

    let outcome: HandlerOutcome;
    try {
      outcome = { kind: "response", response: await handler(request, ctx) };
    } catch (error) {
      outcome = { kind: "threw", error };
    }
    // Before capture, complete or release: a renewal still running would see the completed
    // row and report fenced for nothing, and no timer may outlive the request.
    await lease.settle();

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

  /**
   * A request idemfence does not apply to (row 1): no key on an optional-key route, or a
   * method the adapter does not enforce. A transactional handler still gets ctx.tx, in a
   * plain transaction with no record; a lease handler gets the passthrough context.
   */
  function unapplied(
    request: Request,
    mode: ResolvedRoute["mode"],
    handler: Handler,
  ): Promise<Response> {
    return mode === "transactional"
      ? plainTransaction(request, handler)
      : handler(request, passthroughContext());
  }

  function passthrough(
    request: Request,
    routeConfig: RouteConfig,
    handler: Handler,
  ): Promise<Response> {
    // Only a transactional route needs resolving; a lease route passes straight through,
    // unvalidated, as it always has.
    if (routeConfig.mode !== "transactional") {
      return handler(request, passthroughContext());
    }
    return unapplied(request, resolved(routeConfig).mode, handler);
  }

  return { ready: ensureReady, handle, passthrough };
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

/**
 * Releases a response body that will not be sent; over the cap that is the rest of the
 * handler's own stream.
 */
function cancelBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
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
