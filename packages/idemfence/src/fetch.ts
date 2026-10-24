import { IdemfenceConfigError, type RouteConfig } from "./config.js";
import type { Handler } from "./engine.js";
import type { Idemfence } from "./index.js";

export type { Handler, HandlerContext } from "./engine.js";
export type { Idemfence } from "./index.js";

/** A route for the fetch adapter: the engine's route options plus the methods it enforces. */
export interface FetchRouteConfig extends RouteConfig {
  /**
   * Methods the key is enforced on, compared case-sensitively (methods are case-sensitive).
   * Requests with any other method pass straight to the handler (contract row 1).
   * Default `["POST", "PATCH"]`.
   */
  methods?: readonly string[];
}

// RFC 9110 section 9.1: method = token.
const METHOD_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DEFAULT_METHODS: readonly string[] = ["POST", "PATCH"];

/**
 * Wraps a Web-standard handler so that requests on `route` go through idemfence. The
 * returned function takes a `Request` and returns the `Response` to send; it depends on no
 * framework.
 */
export function idempotent(
  idem: Idemfence,
  route: FetchRouteConfig,
  handler: Handler,
): (request: Request) => Promise<Response> {
  const methods = new Set(validMethods(route.methods));
  // The engine caches validation by route object identity, so one object is built here.
  const { methods: _ignored, ...engineRoute } = route;
  const bodyTooLarge = `#body-too-large>; rel="describedby"`;

  return async (request) => {
    if (!methods.has(request.method)) {
      return handler(request, passthroughContext);
    }
    const response = await idem.handle(request, engineRoute, handler);
    // Row 15: close the connection rather than read the rest of the upload.
    if (
      response.status === 413 &&
      (response.headers.get("link") ?? "").endsWith(bodyTooLarge)
    ) {
      response.headers.set("connection", "close");
    }
    return response;
  };
}

const passthroughContext = {
  async renew() {},
};

function validMethods(value: unknown): readonly string[] {
  const methods = value ?? DEFAULT_METHODS;
  if (
    !Array.isArray(methods) ||
    methods.length === 0 ||
    !methods.every(
      (method) => typeof method === "string" && METHOD_PATTERN.test(method),
    )
  ) {
    throw new IdemfenceConfigError(
      "ROUTE_METHODS_INVALID",
      "Route option `methods` must be a non-empty array of HTTP method tokens (case-sensitive).",
    );
  }
  return methods;
}
