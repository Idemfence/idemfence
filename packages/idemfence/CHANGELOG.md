# idemfence

## 0.1.0

### Minor Changes

- b46ca56: Add `IdemfenceConfigError`, thrown at construction when options are invalid. Each failure has a stable `code`: `STORE_INVALID`, `SCOPE_MISSING`, `SECRET_TOO_SHORT`, `DOCS_URL_NOT_HTTPS`, `DURATION_INVALID`, `LEASE_NOT_SHORTER_THAN_RETENTION`, `KEY_MAX_LENGTH_INVALID`, `BODY_CAP_INVALID`, `RELEASE_STATUS_INVALID`, `NAMESPACE_INVALID`, `HEADER_ALLOWLIST_INVALID`, `REQUIRED_INVALID` and `WEBCRYPTO_MISSING`. Error messages name the offending option and never include secret values.
- e041961: Add the `logger` option (`{ warn, error }`, default `console`; invalid values throw `LOGGER_INVALID`). Log fields carry only a key hash, the contract row, an outcome label, an attempt number and a failing error's name and code, never raw keys, bodies or header values. Route options are validated with `ROUTE_TEMPLATE_INVALID` and `ROUTE_FLAG_INVALID`. `IdemfenceFencedError` is thrown by `ctx.renew()` when another attempt has taken over the lease.
- f0b0cc8: Add the `keySyntax` option: `"sf-string"` (default) accepts only a Structured Field String key, and `"sf-string-or-raw"` also accepts an unquoted key of printable ASCII without spaces, quotes or backslashes, so `abc` and `"abc"` are the same key. Invalid values throw `IdemfenceConfigError` with code `KEY_SYNTAX_INVALID`.
- 609550e: Add the `idemfence/postgres` subpath: `postgresStore({ pool, schema? })` is a lease-mode store on PostgreSQL that takes the caller's `pg.Pool`, with the schema shipped as `migrations/001_init.sql`. `pg` is an optional peer dependency. Store failures that are not a normal outcome throw `IdemfenceStoreError` with a stable `code` (`SCHEMA_VERSION_MISMATCH`, `SCHEMA_NAME_INVALID`, `BEGIN_RACE_EXHAUSTED`); the `Store`, `BeginResult` and `StoredResponse` types are exported from the package root.
- ad98028: Add the public API: `createIdemfence(options)` returns `{ ready(), handle(request, route, handler) }`, and the `idemfence/fetch` subpath exports `idempotent(idem, route, handler)`, which wraps a Web-standard `(request: Request) => Promise<Response>` handler. The route's `methods` (default `["POST", "PATCH"]`, validated with `ROUTE_METHODS_INVALID`) select which requests are enforced; others pass straight through. A 413 for an oversized request body carries `Connection: close`.

### Patch Changes

- Remove the `exactly-once` package keyword: idemfence does not claim exactly-once execution for external side effects.
