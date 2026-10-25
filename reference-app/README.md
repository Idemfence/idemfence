# idemfence reference app

A small [Hono](https://hono.dev) service on Node that uses idemfence through its public
exports only (`idemfence`, `idemfence/fetch`, `idemfence/postgres`) on PostgreSQL, in lease
or transactional mode (`IDEMFENCE_MODE`). It is the target for the conformance suite and a
worked example of wiring idemfence into an application.

## Endpoints

| Method and path | Behaviour |
| --------------- | --------- |
| `POST /orders` | Idempotent (route template `/orders`). Body `{ "item": string, "simulateWorkMs"?: integer 0–30000 }`. Inserts one row into `orders`, waits `simulateWorkMs`, returns `201 { "id", "item" }`. In transactional mode the insert goes through `ctx.tx`, so it commits together with the idempotency record. |
| `GET /orders/count` | `{ "count": n }`: the number of rows in `orders`. |
| `GET /healthz` | `200` once idemfence's `ready()` has verified the schema, otherwise `503`. |

### Conformance fixtures

These routes exist for the conformance suite (`packages/conformance`) and stay permanently:

| Method and path | Behaviour |
| --------------- | --------- |
| `POST /fixtures/release` | Idempotent; always answers `429` (a release status), so the key stays reusable (row 11). In transactional mode it first inserts an order through `ctx.tx`, which the release rolls back. |
| `POST /fixtures/throws` | Idempotent; the handler throws (row 12 in lease mode, row 13 in transactional mode). In transactional mode it first inserts an order through `ctx.tx`, which the throw rolls back. |
| `POST /fixtures/short-retention` | Idempotent with a 500 ms lease and 1.5 s retention; same body and effect as `POST /orders` (row 10). |
| `POST /fixtures/crash` | Idempotent; inserts an order at once (on the pool in lease mode, on `ctx.tx` in transactional mode), then works for 1500 ms, so the Crash group can kill the app mid-request. |
| `POST /fixtures/passthrough` | Not idempotent; echoes the body (row 1). |
| `POST /nonconforming/{orders,release,throws,short-retention,passthrough}` | The same handlers **without idemfence**, so the suite can be shown failing. Never do this in a real application. |

`conformance.json` points the suite at the idempotent routes in lease mode,
`conformance.transactional.json` at the same routes in transactional mode (the app started
with `IDEMFENCE_MODE=transactional`), and `conformance.nonconforming.json` at the
non-conforming group:

```sh
node ../packages/conformance/dist/cli.js --url http://127.0.0.1:3000 --config conformance.json --require-all
node ../packages/conformance/dist/cli.js --url http://127.0.0.1:3000 --config conformance.transactional.json --require-all   # IDEMFENCE_MODE=transactional
node ../packages/conformance/dist/cli.js --url http://127.0.0.1:3000 --config conformance.nonconforming.json   # exits 1
```

Both configs also carry a `crash` section for the Crash group. Its `kill` and `start`
commands are `docker compose -f reference-app/compose.yaml kill -s SIGKILL app` and
`docker compose -f reference-app/compose.yaml start app`. Run that group from the
repository root, with the stack started with `LEASE=5s` (it matches `crash.leaseMs`) and the
compose variables (`POSTGRES_PASSWORD`, `IDEMFENCE_SECRET`) in the environment:

```sh
node packages/conformance/dist/cli.js --url http://127.0.0.1:3000 --config reference-app/conformance.json --group crash
```

### The principal

The idempotent routes take the principal from an `X-Principal` header (1 to 64 printable
ASCII characters, no spaces; a malformed value is a `400`). That exists so the conformance
suite can act as several callers. **A real application must derive the principal from its
authentication** (a session, token or API key), never from a header the client controls:
with a client-chosen principal, any caller could replay or block another caller's keys. A
real application also rejects unauthenticated requests before idemfence runs (`401`); this
app deliberately lets a *missing* header reach idemfence, which answers with the contract's
row 4 (`500 configuration-error`), so the suite can verify that row.

## Configuration

Everything comes from environment variables, validated at startup. The process exits with
a message listing every problem.

| Variable | Required | Meaning |
| -------- | -------- | ------- |
| `DATABASE_URL` | yes | `postgres://` connection URL. The app never runs migrations. |
| `IDEMFENCE_SECRET` | yes | At least 32 bytes. No default. `openssl rand -hex 32` makes one. |
| `DOCS_URL` | yes | `https://` URL of your published idempotency documentation; problem `type` URIs point into it. |
| `PORT` | yes | Port to listen on (1–65535). |
| `IDEMFENCE_MODE` | no | `lease` (default) or `transactional`: the mode of every idempotent route. compose passes `lease` unless it is set. |
| `LEASE` | no | Lease of the idempotent routes, a duration such as `5s` (default `30s`). The Crash group needs a short one that matches `crash.leaseMs` in the conformance config (CI uses `5s`). |

With compose, `POSTGRES_PASSWORD` is also required; `.env.example` lists them all. Copy it
to `.env` and fill in the secrets. Never commit `.env`.

## Running with Docker Compose

```sh
cd reference-app
cp .env.example .env     # then set IDEMFENCE_SECRET and POSTGRES_PASSWORD
docker compose up --build --wait
bash smoke.sh            # keyed POST, replay, count
docker compose down -v   # stop and discard the database
```

For transactional mode, set `IDEMFENCE_MODE=transactional` in `.env` (or in the shell)
before `docker compose up`.

`compose.yaml` starts three services: `postgres` (the digest-pinned `postgres:18.4` image
that CI tests against), `migrate` (a one-shot job that applies idemfence's
`migrations/001_init.sql` and this app's `migrations/002_orders.sql`, skipping both when
they are already present), and `app` (built from `Dockerfile`: multi-stage, a Node 24 image
pinned by digest, a production install from the lockfile only, running as the `node` user).

## Trying it by hand

```sh
curl -i -X POST http://127.0.0.1:3000/orders \
  -H 'Content-Type: application/json' -H 'X-Principal: alice' \
  -H 'Idempotency-Key: "8e03978e-40d5-43e8-bc93-6894a57f9324"' \
  --data '{"item":"widget"}'
```

Send it twice: the second response is the stored one, with `Idempotent-Replayed: true`.
Change the body and keep the key: `422` with an `application/problem+json` body. Send it
without the key: `400`.
