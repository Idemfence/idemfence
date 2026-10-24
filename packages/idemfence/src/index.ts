import {
  type Duration,
  IdemfenceConfigError,
  type IdemfenceConfigErrorCode,
  type IdemfenceOptions,
  type KeySyntax,
  type LogFields,
  type Logger,
  type RouteConfig,
  resolveConfig,
} from "./config.js";
import {
  createEngine,
  type Handler,
  type HandlerContext,
  IdemfenceFencedError,
} from "./engine.js";

export {
  type BeginResult,
  IdemfenceStoreError,
  type IdemfenceStoreErrorCode,
  type Store,
  type StoredResponse,
} from "./store.js";
export type {
  Duration,
  Handler,
  HandlerContext,
  IdemfenceConfigErrorCode,
  IdemfenceOptions,
  KeySyntax,
  LogFields,
  Logger,
  RouteConfig,
};
export { IdemfenceConfigError, IdemfenceFencedError };

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
