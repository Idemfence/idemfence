import {
  type Duration,
  IdemfenceConfigError,
  type IdemfenceConfigErrorCode,
  type IdemfenceOptions,
  type KeySyntax,
  type LogFields,
  type Logger,
  type RouteConfig,
  type RouteMode,
  resolveConfig,
} from "./config.js";
import {
  createEngine,
  type DeriveKey,
  type Handler,
  type HandlerContext,
  type HandlerSignal,
  IdemfenceDeriveError,
  type IdemfenceDeriveErrorCode,
  IdemfenceFencedError,
  IdemfenceHoldLimitError,
  type LeaseHandlerContext,
  type TransactionalHandlerContext,
} from "./engine.js";

export {
  type BeginResult,
  IdemfenceStoreError,
  type IdemfenceStoreErrorCode,
  type SqlExecutor,
  type SqlResult,
  type Store,
  type StoredResponse,
  type StoreTransaction,
  type TransactionalStore,
} from "./store.js";
export type {
  DeriveKey,
  Duration,
  Handler,
  HandlerContext,
  HandlerSignal,
  IdemfenceConfigErrorCode,
  IdemfenceDeriveErrorCode,
  IdemfenceOptions,
  KeySyntax,
  LeaseHandlerContext,
  LogFields,
  Logger,
  RouteConfig,
  RouteMode,
  TransactionalHandlerContext,
};
export {
  IdemfenceConfigError,
  IdemfenceDeriveError,
  IdemfenceFencedError,
  IdemfenceHoldLimitError,
};

/** An idemfence instance: validated configuration bound to a store. */
export interface Idemfence {
  /** Verifies the store's schema; rejects with `IdemfenceStoreError` when it is not usable. */
  ready(): Promise<void>;
  /**
   * Applies the contract to one request on a configured route and returns the response to
   * send. Adapters (such as `idemfence/fetch`) call this for the routes and methods they
   * enforce.
   */
  handle(
    request: Request,
    route: RouteConfig,
    handler: Handler,
  ): Promise<Response>;
  /**
   * Runs `handler` for a request on a configured route that idemfence does not apply to,
   * such as a method the adapter does not enforce (contract row 1). Adapters call this
   * instead of calling the handler directly. On a `mode: "transactional"` route the handler
   * runs in a plain transaction with `ctx.tx` and no record (committed when it resolves,
   * rolled back and rethrown when it throws), as for a request without a key. On a lease
   * route it gets a context whose `renew` does nothing. Either way `ctx.deriveKey` rejects
   * with `DERIVE_KEY_UNAVAILABLE`.
   */
  passthrough(
    request: Request,
    route: RouteConfig,
    handler: Handler,
  ): Promise<Response>;
}

/** Validates `options` (throwing `IdemfenceConfigError`) and returns an instance. */
export function createIdemfence(options: IdemfenceOptions<Request>): Idemfence {
  const engine = createEngine(resolveConfig(options));
  return {
    ready: () => engine.ready(),
    handle: (request, route, handler) => engine.handle(request, route, handler),
    passthrough: (request, route, handler) =>
      engine.passthrough(request, route, handler),
  };
}
