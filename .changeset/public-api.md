---
"idemfence": minor
---

Add the public API: `createIdemfence(options)` returns `{ ready(), handle(request, route, handler) }`, and the `idemfence/fetch` subpath exports `idempotent(idem, route, handler)`, which wraps a Web-standard `(request: Request) => Promise<Response>` handler. The route's `methods` (default `["POST", "PATCH"]`, validated with `ROUTE_METHODS_INVALID`) select which requests are enforced; others pass straight through. A 413 for an oversized request body carries `Connection: close`.
