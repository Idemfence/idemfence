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
  on Hono over HTTP/1.1 and HTTP/2. The key is enforced on the route's `methods` (default
  `["POST", "PATCH"]`); other methods reach the handler without idemfence through
  `idem.passthrough()`, which on a transactional route still opens a plain transaction for
  `ctx.tx` (see below).
- `idemfence/postgres`: `postgresStore({ pool, schema?, lockTimeout? })` on PostgreSQL. The
  schema ships as `idemfence/postgres/migrations/001_init.sql`.
- `idemfence-conformance` (in this repository): a black-box suite that checks a running
  service against the contract, row by row, plus a concurrency group.

Redis and the Express and Fastify adapters are not released yet.

## Lease mode: heartbeat, ctx.signal and maxHold

In lease mode (the default) a request claims its key with a lease. While the handler runs,
idemfence renews the lease every `lease / 3` (the heartbeat), so a handler may take longer
than `lease` without anyone taking its key over. The lease matters when a process dies or
hangs: another attempt can take the key over (contract row 9) once the lease expires on the
database's clock.

- **Sizing `lease`** (default `"30s"`): it is how long a key stays blocked after its holder
  crashes, and the heartbeat must reach the database at least once per lease. Keep it well
  above your database's worst-case round trip, and well below what a waiting client will
  put up with. Every attempt answers a concurrent duplicate with a 409 whose `Retry-After`
  is the remaining lease.
- **`ctx.signal`** aborts when this attempt has lost its lease: a renewal found that another
  attempt took the key over (`signal.reason` is an `IdemfenceFencedError`), or the hold limit
  was reached (`IdemfenceHoldLimitError`). Pass it to downstream calls so they stop, and
  combine it with `ctx.deriveKey` so a call that did go through is not repeated by the
  attempt that took over:

  ```ts
  const pay = idempotent(idem, { routeTemplate: "/orders/:id/pay" }, async (request, ctx) => {
    const response = await fetch("https://payments.example.com/v1/charges", {
      method: "POST",
      signal: ctx.signal,
      headers: { "idempotency-key": await ctx.deriveKey("payment-charge") },
      body: await request.text(),
    });
    return new Response(response.body, { status: response.ok ? 201 : 502 });
  });
  ```

  Aborting the signal interrupts nothing by itself: a handler that ignores it runs to the
  end, and its response goes to its own client without being stored. The signal is not the
  request's signal: a client that disconnects does not abort it (contract row 16). It never
  aborts in transactional mode, on a fail-open run, or on a request idemfence does not apply
  to.
- **`heartbeat: false`** on a route turns the timer off; the handler then keeps its lease
  with `await ctx.renew()`, which rejects with `IdemfenceFencedError` (after aborting
  `ctx.signal`) once another attempt has taken over.
- **`maxHold`** (instance option, default `min(10 × lease, retention, 2147483647 ms)`) bounds how long one
  process keeps a lease alive. After `maxHold`, measured from acquisition on the process's
  own monotonic clock, the heartbeat stops, `ctx.signal` aborts with
  `IdemfenceHoldLimitError`, `ctx.renew()` rejects with it, and the lease expires one lease
  later on the database's clock. A key is therefore never blocked for longer than
  `maxHold + lease` by a handler that hangs while its process stays alive. It must be
  greater than `lease` (`MAX_HOLD_NOT_LONGER_THAN_LEASE`), no greater than `retention`
  (`MAX_HOLD_LONGER_THAN_RETENTION`), and at most 2147483647 ms, about 24.8 days, the
  longest delay a timer can wait (`MAX_HOLD_TOO_LONG`). With `maxHold` left at its
  default, `lease` must therefore stay below that cap.

Lease renewals that fail with a store error are logged (`renew-failed`) and retried at the
next interval; fenced renewals and the hold limit are logged with outcomes `fenced` and
`hold-limit`.

### What a crash leaves behind

If the process running a handler dies (killed, out of memory, power loss):

- **Lease mode:** retries get a 409 until the dead attempt's lease expires (at most one
  `lease` after its last renewal); the first retry after that runs the handler again and
  its outcome is stored. At most one attempt runs at a time, and exactly one outcome is
  stored. But anything the dead attempt already wrote (a row on your own connection, a
  call to another service) is still there, and the retry runs again, so guard such writes
  with `ctx.deriveKey`: an upsert keyed by it, or the key passed to the downstream service,
  is the same on the retry. If the process dies after the outcome was stored, the retry
  replays it.
- **Transactional mode:** the dead attempt's transaction rolls back, record included, so its
  writes through `ctx.tx` are gone and the very next retry runs the handler.

The repository tests both: `packages/idemfence/test/crash.test.ts` kills a real process at
four points of a request, and the conformance suite's Crash group kills a running service.

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
  reaches the pooled connection, which may already serve another request. Finish every
  query before returning: a response body that streams after `COMMIT` (one over
  `responseBodyCap`, or any body on a request without a key) must not read from `ctx.tx`.
- A request idemfence does not apply to runs the handler in a plain transaction with no
  record: committed when the handler returns, rolled back (and the error rethrown) when it
  throws. That covers a request without a key on an optional-key route
  (`required: false`), and, with `idemfence/fetch`, a method outside the route's `methods`
  (for example a GET on the default POST and PATCH). `ctx.tx` is there either way, and
  `ctx.deriveKey` rejects with `DERIVE_KEY_UNAVAILABLE`.

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

## Derived downstream keys

A handler that calls another service on the request's behalf needs its own idempotency key
for that call, one that is the same on every attempt of the same request. Otherwise a retry
that runs the handler again (after a throw in transactional mode, a release status, a lease
takeover, or a fail-open run) would repeat the downstream side effect. `ctx.deriveKey(label)`
returns that key: 64 lowercase hex characters, an HMAC-SHA256 of the request's lookup key,
its fingerprint and the label ([contract](https://github.com/idemfence/idemfence/blob/main/docs/contract.md)
section 5, with test vectors in Appendix A).

For example, with a payment provider that accepts an `Idempotency-Key` header (Stripe is
one; any provider with an equivalent works the same way):

```ts
const charge = idempotent(idem, { routeTemplate: "/orders/:id/pay" }, async (request, ctx) => {
  const { amount } = await request.json();
  const response = await fetch("https://payments.example.com/v1/charges", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.PAYMENTS_API_KEY}`,
      "content-type": "application/json",
      // The same on every attempt of this request, so the provider charges once.
      "idempotency-key": await ctx.deriveKey("payment-charge"),
    },
    body: JSON.stringify({ amount }),
  });
  return Response.json(await response.json(), { status: response.ok ? 201 : 502 });
});
```

- Use one label per downstream call (`payment-charge`, `payment-refund`, `email-receipt`):
  1 to 128 printable ASCII characters (0x21 to 0x7E). Anything else rejects with
  `IdemfenceDeriveError` code `DERIVE_LABEL_INVALID`.
- A request without an `Idempotency-Key` (an optional-key route, or a method the adapter does
  not enforce) has nothing to derive from: `ctx.deriveKey` is still there, but rejects with
  code `DERIVE_KEY_UNAVAILABLE`.
- Derived keys never appear in idemfence's logs or in the problem responses it generates.
- The key depends on the client's `Idempotency-Key` (through the lookup key) and on the
  request fingerprint, so a reused key with a different payload derives a different
  downstream key, including when it reaches your handler after `retention` or on a
  fail-open run. Changing the fingerprint's configuration (`headerAllowlist`) changes the
  derived keys of requests whose attempts straddle the change.

**Secrets and rotation.** `secret` is the current secret and `previousSecrets` the earlier
ones, newest first and oldest last. Derived keys use the oldest configured secret: the last
entry of `previousSecrets`, or `secret` when there are none. To rotate:

1. Set the new value as `secret` and move the old one to the front of `previousSecrets`.
   No derived key changes.
2. Remove the last (oldest) entry of `previousSecrets` only when you mean to re-key. Every
   derived key then changes, so a request whose attempts straddle the removal (the first
   attempt before it, a retry after it) sends a new key to the downstream service on its
   later attempt, and that service may perform the side effect again. Remove the oldest
   secret when no request older than your retention can still be retried, or accept that
   risk.

## TypeScript

The public types use the Web `Request`, `Response` and `Headers` globals. A consumer with
TypeScript's default `lib` (which includes DOM) typechecks without `@types/node`; a consumer
that restricts `lib` needs either `@types/node` (22 or later) or the DOM lib for those names.
`idemfence/postgres` imports the `Pool` type from `pg`, so its consumers need `@types/pg`.

## License

idemfence is licensed under the [Apache License, Version 2.0](LICENSE).
See [NOTICE](NOTICE) for attribution.
