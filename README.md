# idemfence

idemfence is a drop-in HTTP middleware for TypeScript that implements the IETF
[Idempotency-Key HTTP header field draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/).
It fingerprints each request so a reused key with a different payload is rejected,
replays the stored response for a retried request, detects a retry that arrives while
the original is still in flight and answers it with a conflict, and uses fencing tokens
so a worker that crashes or stalls mid-request cannot later overwrite the result of the
one that took over.

**Status: 0.x — early release.** The behaviour contract,
[docs/contract.md](https://github.com/Idemfence/idemfence/blob/main/docs/contract.md), is
normative and changes only with a major version once 1.0 ships.

## Install

```sh
npm install idemfence
```

Node 22.13 or later. The Postgres store (`idemfence/postgres`) uses your own
[`pg`](https://www.npmjs.com/package/pg) pool; `pg` is an optional peer dependency.

## What is in the box

- `idemfence`: `createIdemfence(options)`, the contract engine behind `handle(request, route,
  handler)`, with configuration validated at construction (`IdemfenceConfigError`).
- `idemfence/fetch`: `idempotent(idem, route, handler)` wraps a Web-standard
  `(request: Request) => Promise<Response>` handler; it depends on no framework and is tested
  on Hono over HTTP/1.1 and HTTP/2.
- `idemfence/postgres`: `postgresStore({ pool, schema?, lockTimeout? })` on PostgreSQL. The
  schema ships as `idemfence/postgres/migrations/001_init.sql`. It also exports
  `withTransaction(pool, { lockTimeout? }, fn)`, which runs `fn` on one pooled client inside
  `BEGIN` / `SET LOCAL lock_timeout` / `COMMIT`, rolling back when `fn` throws.
- `idemfence-conformance` (in this repository): a black-box suite that checks a running
  service against the contract, row by row, plus a concurrency group.

Redis and the Express and Fastify adapters are not released yet.

## Transactional mode

A route with `mode: "transactional"` runs its handler inside one of the store's
transactions and passes it to the handler as `ctx.tx`, a `SqlExecutor`
(`query(text, params)`, the interface a `pg` `Pool` or `PoolClient` already satisfies).
Everything the handler writes through `ctx.tx` commits when the handler returns and rolls
back when it throws. In lease mode `ctx.tx` is absent.

```ts
import { createIdemfence } from "idemfence";
import { idempotent } from "idemfence/fetch";
import { postgresStore } from "idemfence/postgres";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
// Required: node-postgres emits errors from idle clients (for example a backend that
// died while the client sat in the pool) on the pool. Without a handler they crash the
// process.
pool.on("error", (error) => {
  console.error("pg pool error", error);
});

const store = postgresStore({ pool, lockTimeout: "250ms" });
const idem = createIdemfence({ store, scope, secret, docsUrl });

const createOrder = idempotent(
  idem,
  { routeTemplate: "/orders", mode: "transactional" },
  async (request, ctx) => {
    await ctx.tx?.query("INSERT INTO orders (id) VALUES ($1)", [orderId]);
    return Response.json({ id: orderId }, { status: 201 });
  },
);
```

Your `pg.Pool` must have a `pool.on("error", ...)` handler, as in the example above:
node-postgres emits idle-client errors on the pool, and an `'error'` event with no listener
crashes the process. idemfence handles errors on the client it has checked out for a
transaction and destroys that client instead of returning it to the pool; the pool handler
covers clients that fail while idle.

The transaction holds one pool connection for the handler's whole duration, so size the
pool for the number of transactional handlers that may run at once, and set
[`idle_in_transaction_session_timeout`](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-IDLE-IN-TRANSACTION-SESSION-TIMEOUT)
on the server so a stalled handler cannot hold a connection open indefinitely. The
transaction's `lock_timeout` (default 250 ms, `lockTimeout` on the store) bounds how long a
statement waits for a row lock; an invalid value throws `IdemfenceConfigError` with code
`LOCK_TIMEOUT_INVALID`. Writing the idempotency record inside the handler's transaction, so
that the record and the handler's writes commit or roll back together (contract rows 11 and
13), is the next step; until then the record follows lease mode.

Another SQL driver can be used in place of `pg` by implementing `SqlExecutor` and a store
that accepts it; only the Postgres store ships today.

## TypeScript

The public types use the Web `Request`, `Response` and `Headers` globals. A consumer with
TypeScript's default `lib` (which includes DOM) typechecks without `@types/node`; a consumer
that restricts `lib` needs either `@types/node` (22 or later) or the DOM lib for those names.
`idemfence/postgres` imports the `Pool` type from `pg`, so its consumers need `@types/pg`.

## License

idemfence is licensed under the [Apache License, Version 2.0](LICENSE).
See [NOTICE](NOTICE) for attribution.
