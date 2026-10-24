---
"idemfence": minor
---

Add the `logger` option (`{ warn, error }`, default `console`; invalid values throw `LOGGER_INVALID`). Log fields carry only a key hash, the contract row, an outcome label, an attempt number and a failing error's name and code, never raw keys, bodies or header values. Route options are validated with `ROUTE_TEMPLATE_INVALID` and `ROUTE_FLAG_INVALID`. `IdemfenceFencedError` is thrown by `ctx.renew()` when another attempt has taken over the lease.
