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
  IdemfenceDeriveError,
  type IdemfenceDeriveErrorCode,
  IdemfenceFencedError,
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
export { IdemfenceConfigError, IdemfenceDeriveError, IdemfenceFencedError };

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
}

/** Validates `options` (throwing `IdemfenceConfigError`) and returns an instance. */
export function createIdemfence(options: IdemfenceOptions<Request>): Idemfence {
  const engine = createEngine(resolveConfig(options));
  return {
    ready: () => engine.ready(),
    handle: (request, route, handler) => engine.handle(request, route, handler),
  };
}
