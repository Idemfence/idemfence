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
The idempotency record is written in that same transaction, so the record and everything
the handler writes through `ctx.tx` commit or roll back together
([contract](https://github.com/idemfence/idemfence/blob/main/docs/contract.md) section 7):

- The handler returns a response: idemfence stores it with the record, commits, and only
  then sends it (store-then-send). A retry replays it.
- The handler throws: everything rolls back, the client gets a 500 `about:blank` problem,
  nothing is stored, and a retry runs the handler again (row 13).
- The handler returns a release status (default 408, 425, 429): everything rolls back and
  the response is returned as-is, so the key can be retried (row 11).
- The record cannot be written or the commit fails: everything rolls back (or, if the
  connection died during `COMMIT`, either everything or nothing landed) and the client gets
  a 503 store-unavailable with `Retry-After`. The handler's response is never sent in that
  case, because none of it was committed.

The transaction is the lease, so `ctx.renew` is absent in this mode: a lease update inside
the uncommitted transaction would be invisible to other sessions and would row-lock the
record. In lease mode it is the other way round: `ctx.renew()` extends the lease and
`ctx.tx` is absent.

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

Rules for `ctx.tx`:

- Never run `BEGIN`, `COMMIT` or `ROLLBACK` on it: idemfence ends the transaction itself,
  after storing the response. `SAVEPOINT`, `RELEASE SAVEPOINT` and `ROLLBACK TO SAVEPOINT`
  are fine.
- A failed statement aborts the whole transaction even if the handler catches the error;
  the request is then answered 503 and nothing is committed. Wrap a statement that may fail
  in a savepoint.
- It is dead once the transaction ends: a query on it after the response was committed or
  rolled back rejects at once with `IdemfenceStoreError` code `TRANSACTION_ENDED` and never
  reaches the pooled connection, which may already serve another request. A response body
  over `responseBodyCap` is streamed to the client after `COMMIT`, so it must not read from
  `ctx.tx`.
- On an optional-key route (`required: false`), a request without a key runs the handler in
  a plain transaction with no record: committed when the handler returns, rolled back when
  it throws.

A concurrent request with the same key waits on the first one's uncommitted record for up
to the store's `lockTimeout` (default 250 ms; an invalid value throws
`IdemfenceConfigError` with code `LOCK_TIMEOUT_INVALID`), then gets a 409 in-flight with
`Retry-After` set to that timeout in whole seconds. If the first one commits during the
wait, the duplicate gets its stored response (or, under `REPEATABLE READ` or
`SERIALIZABLE`, a 409 whose retry gets it). The lock timeout covers only the statements
that claim the record: idemfence restores the previous `lock_timeout` before calling the
handler, so the handler's own statements run with the connection's normal setting.

`failOpen: true` cannot be combined with `mode: "transactional"`
(`IdemfenceConfigError` code `FAIL_OPEN_TRANSACTIONAL`): fail-open runs the handler without
the store, and a transactional handler runs inside the store's transaction.

The transaction holds one pool connection for the handler's whole duration, and idemfence
never takes a second one while it is open. Size the pool for the number of transactional
handlers that may run at once, and set
[`idle_in_transaction_session_timeout`](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-IDLE-IN-TRANSACTION-SESSION-TIMEOUT)
on the server so a stalled handler cannot hold a connection open indefinitely.

When you switch a route from lease to transactional mode with a rolling deploy, instances
of both modes serve the same keys for a while. A lease-mode instance claims the record with
an autocommit statement that sets no `lock_timeout` of its own, so when a transactional instance holds the
same key, the lease-mode request waits for the whole of that handler's run before it gets
its answer. Keep that window short, or drain one mode before the other takes traffic.

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
