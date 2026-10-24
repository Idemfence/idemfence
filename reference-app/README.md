# idemfence reference app

A small [Hono](https://hono.dev) service on Node that uses idemfence through its public
exports only (`idemfence`, `idemfence/fetch`, `idemfence/postgres`), in lease mode on
PostgreSQL. It is the target for the conformance suite and a worked example of wiring
idemfence into an application.

## Endpoints

| Method and path | Behaviour |
| --------------- | --------- |
| `POST /orders` | Idempotent (route template `/orders`). Body `{ "item": string, "simulateWorkMs"?: integer 0–30000 }`. Inserts one row into `orders`, waits `simulateWorkMs`, returns `201 { "id", "item" }`. |
| `GET /orders/count` | `{ "count": n }`: the number of rows in `orders`. |
| `GET /healthz` | `200` once idemfence's `ready()` has verified the schema, otherwise `503`. |

### The principal

`POST /orders` takes the principal from an `X-Principal` header (1 to 64 printable ASCII
characters, no spaces; otherwise `400`). That exists so the conformance suite can act as
several callers. **A real application must derive the principal from its authentication**
(a session, token or API key), never from a header the client controls: with a
client-chosen principal, any caller could replay or block another caller's keys.

## Configuration

Everything comes from environment variables, validated at startup. The process exits with
a message listing every problem.

| Variable | Required | Meaning |
| -------- | -------- | ------- |
| `DATABASE_URL` | yes | `postgres://` connection URL. The app never runs migrations. |
| `IDEMFENCE_SECRET` | yes | At least 32 bytes. No default. `openssl rand -hex 32` makes one. |
| `DOCS_URL` | yes | `https://` URL of your published idempotency documentation; problem `type` URIs point into it. |
| `PORT` | yes | Port to listen on (1–65535). |

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
