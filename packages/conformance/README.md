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

Exit status is 0 only when no scenario failed and, with `--require-all`, none was not run.
Rows 9, 13 and 14 are not testable black-box and are reported as such; they never fail and
are not counted by `--require-all`.

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
| `fixtures` | no | Routes the target provides; any may be absent. A scenario that needs a missing fixture reports `not run: fixture <name> missing`. |

Every fixture except `count` and `noPrincipal` has `method`, `path` and an optional JSON
`body`:

| Fixture | Used by rows | Extra fields |
| ------- | ------------ | ------------ |
| `create` | 2, 3, 5, 6, 7, 15 | `alternateBody`: a different payload with the same key (row 7). |
| `count` | all rows that check side effects | `path` only; `GET` must return `{ "count": n }`. |
| `slow` | 8, 16 | `workMs`: how long the handler takes (at least 500). |
| `release` | 11 | `status`: the release status the route returns (400–599). |
| `throws` | 12 | none; the handler must throw. |
| `shortRetention` | 10 | `retentionMs`: the route's retention (at least 100). The suite waits `retentionMs + 600`. |
| `passthrough` | 1 | none; a route or method the target does not make idempotent. |
| `noPrincipal` | 4 | `omitHeaders`: headers to leave out so the target sees no principal. |

The suite generates its own keys (`idemfence-conformance-<UUID>`), sent as Structured Field
Strings, and never reuses one across rows.
