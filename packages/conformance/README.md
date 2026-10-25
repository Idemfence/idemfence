# idemfence-conformance

A black-box conformance suite for the idemfence behaviour contract
([docs/contract.md](../../docs/contract.md)). It sends real HTTP requests to a target and
checks each contract row's status, headers, problem body and side-effect count. The CLI has
no runtime dependencies.

```sh
idemfence-conformance --url http://127.0.0.1:3000 --config target.json [--json] [--require-all] [--only 5,6]
```

| Option | Meaning |
| ------ | ------- |
| `--url` | Base URL of the target. |
| `--config` | Target configuration file (below). |
| `--json` | Machine-readable output: `{ url, results, summary }`. |
| `--require-all` | A scenario that was not run (missing fixture) counts as a failure. |
| `--only` | Comma-separated contract row numbers to run; the rest are reported as skipped. |
| `--group` | `contract` (default), `concurrency` or `crash` (runs the config's `crash.kill` and `crash.start` commands). |
| `--iterations` | Concurrency group: number of bursts (default 1000). |
| `--concurrency` | Concurrency group: requests per burst (default 50). |

Exit status is 0 only when no scenario failed and, with `--require-all`, none was not run.
Rows 9, 13 and 14 are not testable black-box and are reported as such; they never fail and
are not counted by `--require-all`.

## Modes

The config's `mode` says which idemfence mode the target's routes use (docs/contract.md
section 7): `"lease"` (the default) or `"transactional"`. In transactional mode:

- row 13 is tested: the `throws` fixture's first response must be a 500 `about:blank`
  problem that is not replayed, a retry with the same key must be another fresh 500 (the
  throw was rolled back, not stored), and the side-effect count must not change, so the
  fixture should write a side effect before it throws;
- row 11 also checks that the side-effect count did not change (the release rolls the
  handler's writes back);
- rows 9 and 12 do not apply (a crashed handler's transaction rolls back; a throw is not
  stored) and are reported as `not applicable in transactional mode`, with the outcome
  `not_applicable` in JSON. Like not-testable rows they never fail and are not counted by
  `--require-all`. The JSON summary then has a `notApplicable` count.

In lease mode the output is the same as before modes existed.

## The Concurrency group

`--group concurrency` fires `--iterations` bursts (default 1000) of `--concurrency` identical
requests (default 50) at the `slow` fixture, each burst with a fresh key. Every connection is
opened and the request head sent first; then every body is released together, each after a
random 0–5 ms jitter. The handler's duration alternates per burst: the `slow` fixture's
`workField` (default `simulateWorkMs`) is set to a random 0–20 ms, so some requests arrive
while the first is in flight and some after it completed. For each burst the suite asserts
that `count` rose by exactly 1; exactly one response is a non-replayed 2xx; every other
response is a 409 in-flight problem with an integer `Retry-After` or a byte-identical replay
with `Idempotent-Replayed: true`; and there is no 5xx and no connection error. A failing
burst is reported with its iteration number, key prefix, status histogram and count delta.
Connections are kept alive across bursts so a long run does not exhaust local ports.

## The Crash group

`--group crash` checks what a retry sees after the target dies mid-request.
1. It sends the `crash` fixture.
2. 500 ms later it kills the target with the config's `crash.kill` command.
3. It restarts the target with `crash.start` and waits until `crash.readyPath` answers 200.
4. It retries with the same key and body.

**The CLI runs `crash.kill` and `crash.start` itself.** They are argv arrays run with
`execFile`, without a shell, from the directory you start the CLI in. Only use a config
whose commands you have read.

- **Lease mode** (`crash.leaseMs` required):
  - every retry is a 409 in-flight problem with an integer `Retry-After` until one is
    answered otherwise;
  - that request must be sent no later than `crash.leaseMs` plus 3000 ms (`CRASH_SLACK_MS`)
    after the target was ready again;
  - it must be a fresh 2xx, not a replay;
  - between the restart and that answer the side-effect count rises by exactly 1;
  - a further retry replays it byte for byte.

  The killed attempt's own side effect survives in this mode; the output notes it.
- **Transactional mode:**
  - the first retry after the restart is a fresh 2xx (the killed attempt's transaction rolled
    back);
  - the count rises by exactly 1 over the whole scenario;
  - a further retry replays.

The `crash` fixture's handler must write its side effect at once, then work for well over
500 ms, so the kill lands while it is running. Choose a short lease (a few seconds) for the
target, so the 409 window is observed but ends soon. It must still be longer than the target
takes to restart, or no 409 is seen at all.

## Side effects

Every scenario creates real side effects in the target: records in its idempotency store
and whatever its handlers do (the reference app creates orders). The CLI refuses to run
unless the config contains `"acknowledgeSideEffects": true`, and prints a one-line banner
with the target URL before starting. **Never point it at production.**

Every key the suite sends is `idemfence-conformance-<random UUID>`, so its requests are
identifiable in the target's logs and can never collide with a real client's key. The
records themselves cannot be found by key in the store: idemfence stores only hashed lookup
keys. They expire after the target's retention and are removed by its purge. The handlers'
side effects (such as orders) are the target's own data. Run the suite against a disposable
environment, for example the reference app's compose stack, and discard it afterwards with
`docker compose down -v`.

## Target configuration

```json
{
  "acknowledgeSideEffects": true,
  "headers": { "X-Principal": "conformance" },
  "keyMaxLength": 255,
  "requestBodyCap": 1048576,
  "keySyntax": "sf-string",
  "fixtures": {
    "create": { "method": "POST", "path": "/orders", "body": { "item": "widget" }, "alternateBody": { "item": "gadget" } },
    "count": { "path": "/orders/count" },
    "slow": { "method": "POST", "path": "/orders", "body": { "item": "slow", "simulateWorkMs": 1500 }, "workMs": 1500 },
    "release": { "method": "POST", "path": "/fixtures/release", "body": { "item": "widget" }, "status": 429 },
    "throws": { "method": "POST", "path": "/fixtures/throws", "body": { "item": "widget" } },
    "shortRetention": { "method": "POST", "path": "/fixtures/short-retention", "body": { "item": "widget" }, "retentionMs": 1500 },
    "passthrough": { "method": "POST", "path": "/fixtures/passthrough", "body": { "item": "widget" } },
    "noPrincipal": { "omitHeaders": ["X-Principal"] }
  }
}
```

| Field | Required | Meaning |
| ----- | -------- | ------- |
| `acknowledgeSideEffects` | yes | Must be `true`; see "Side effects" above. |
| `headers` | no | Headers sent on every request: a principal, an auth token, and so on. Default `{}`. |
| `keyMaxLength` | yes | The target's maximum key length (1–255), for the over-length case of row 3. |
| `requestBodyCap` | yes | The target's request body cap in bytes, for row 15. |
| `keySyntax` | no | `sf-string` (default) or `sf-string-or-raw`. With raw syntax an unquoted key is valid, so row 3 does not send one. |
| `mode` | no | `lease` (default) or `transactional`; see "Modes" above. |
| `crash` | Crash group | `{ "kill": [argv], "start": [argv], "readyPath": "/healthz", "leaseMs": 5000 }`; see "The Crash group" above. `leaseMs` is required in lease mode. |
| `fixtures` | no | Routes the target provides; any may be absent. A scenario that needs a missing fixture reports `not run: fixture <name> missing`. |

Every fixture except `count` and `noPrincipal` has `method`, `path` and an optional JSON
`body`:

| Fixture | Used by rows | Extra fields |
| ------- | ------------ | ------------ |
| `create` | 2, 3, 5, 6, 7, 15 | `alternateBody`: a different payload with the same key (row 7). |
| `count` | all rows that check side effects | `path` only; `GET` must return `{ "count": n }`. |
| `slow` | 8, 16, concurrency | `workMs`: how long the handler takes (at least 500). `workField` (optional, default `simulateWorkMs`): the body field the concurrency group sets to a random 0–20 ms. |
| `release` | 11 | `status`: the release status the route returns (400–599). |
| `throws` | 12 (lease), 13 (transactional) | none; the handler must throw (in transactional mode, after writing a side effect). |
| `shortRetention` | 10 | `retentionMs`: the route's retention (at least 100). The suite waits `retentionMs + 600`. |
| `passthrough` | 1 | none; a route or method the target does not make idempotent. |
| `noPrincipal` | 4 | `omitHeaders`: headers to leave out so the target sees no principal. |
| `crash` | Crash group | none; the handler writes one side effect at once, then works for well over 500 ms. |

The suite generates its own keys (`idemfence-conformance-<UUID>`), sent as Structured Field
Strings, and never reuses one across rows.
