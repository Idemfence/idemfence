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
- `idemfence/postgres`: `postgresStore({ pool, schema? })`, lease mode on PostgreSQL. The
  schema ships as `idemfence/postgres/migrations/001_init.sql`.
- `idemfence-conformance` (in this repository): a black-box suite that checks a running
  service against the contract, row by row, plus a concurrency group.

Transactional mode, Redis, and the Express and Fastify adapters are not released yet.

## TypeScript

The public types use the Web `Request`, `Response` and `Headers` globals. A consumer with
TypeScript's default `lib` (which includes DOM) typechecks without `@types/node`; a consumer
that restricts `lib` needs either `@types/node` (22 or later) or the DOM lib for those names.
`idemfence/postgres` imports the `Pool` type from `pg`, so its consumers need `@types/pg`.

## License

idemfence is licensed under the [Apache License, Version 2.0](LICENSE).
See [NOTICE](NOTICE) for attribution.
