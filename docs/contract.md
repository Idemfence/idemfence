# idemfence behaviour contract

**Status:** normative draft for idemfence 1.0. No implementation has been released yet; this
document defines the behaviour that every release MUST implement.

This document specifies how idemfence handles requests that carry the `Idempotency-Key`
header field defined by the IETF Internet-Draft
[The Idempotency-Key HTTP Header Field][draft] (draft-ietf-httpapi-idempotency-key-header-08,
22 October 2026). Error responses use Problem Details for HTTP APIs ([RFC 9457][rfc9457]).

Where the draft says SHOULD for a status code (400, 409, 422), this contract says MUST.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in BCP 14 ([RFC 2119][rfc2119], [RFC 8174][rfc8174]) when, and only
when, they appear in all capitals, as shown here.

Terms used below:

- **Configured route**: a route template and HTTP method that the application has explicitly
  placed under idemfence.
- **Principal**: the authenticated identity that owns a key, as returned by the configured
  scope function (for example a user ID or API client ID).
- **Record**: the stored state for one lookup key: in flight or completed, the request
  fingerprint, the fencing token and, once completed, the stored response.
- **Lease**: a time-limited, exclusive claim on an in-flight record, measured on the store's
  clock.
- **Fencing token**: an integer stored with the record that increases by at least one each
  time a lease is acquired. A token value is never reused, even after the record is deleted
  and recreated.
- **Retention**: how long a record is kept after it is created. It is configured per route
  and MUST be longer than the lease.

### Length-prefixed encoding

`enc(x)` is the byte length of `x` as an unsigned 64-bit big-endian integer, followed by the
bytes of `x`. Text values are encoded as UTF-8. A hash input is the concatenation of `enc()`
of each listed field, in order. Every hash input starts with a fixed domain tag, so a lookup
key can never equal a fingerprint.

## 1. Scope

1. idemfence MUST apply only to configured routes and methods. Every other request MUST pass
   through untouched (row 1).
2. The middleware MUST run after authentication, so that the principal is known when the
   lookup key is computed.
3. The middleware MUST have access to the raw request body bytes before any body parser
   consumes them.

## 2. Key

1. The `Idempotency-Key` field is an Item Structured Field whose value MUST be a String
   (Section 3.3.3 of [RFC 9651][rfc9651]), as required by Section 2.1 of the draft. For
   example: `Idempotency-Key: "8e03978e-40d5-43e8-bc93-6894a57f9324"`. The field is parsed
   with the Item algorithm of Section 4.2 of RFC 9651. Parameters on the Item are parsed
   and ignored. Multiple `Idempotency-Key` field lines are combined into one comma-separated
   value before parsing, so a request that carries more than one is malformed.
2. The decoded String MUST be 1 to 255 characters long. The maximum is configurable per
   route.
3. Every character of the decoded String MUST be printable ASCII (0x20 to 0x7E). A field
   that does not parse as an sf-string, is too long, or contains any other character is
   malformed (row 3).
4. A route MAY set `keySyntax` to `sf-string-or-raw` (the default is `sf-string`). Then a
   field value that does not start with DQUOTE is accepted as the key as-is if it is 1 to
   the route's maximum characters, each in 0x21 to 0x7E other than DQUOTE and backslash. A
   value that starts with DQUOTE is still parsed as in item 1. The raw form `abc` and the
   quoted form `"abc"` MUST resolve to the same key, and therefore the same lookup key.
   Rationale: many clients send unquoted keys, including clients following Stripe's
   documented examples.
5. A configured route requires a key by default. A route MAY be configured with the key
   optional; a request without a key on such a route is handled as in row 1.
6. The lookup key is:

   ```
   SHA-256( enc("idemfence/lookup/v1") || enc(namespace) || enc(principal)
            || enc(method) || enc(route template) || enc(client key) )
   ```

   where `namespace` is the configured namespace string, `method` is the request method as
   received, `route template` is the configured template (for example `/orders/:id`), and
   `client key` is the decoded String from the header (or the raw key, item 4).
7. Raw client keys MUST NOT be stored. Only the lookup key is persisted. Raw client keys
   SHOULD NOT be logged.

## 3. Fingerprint

1. The request fingerprint is:

   ```
   SHA-256( enc("idemfence/fingerprint/v1") || enc(method) || enc(concrete path)
            || enc(canonical query) || enc(content type) || enc(header block)
            || enc(body) )
   ```

2. `concrete path` is the pathname of the request URL as parsed by the WHATWG URL Standard
   (`new URL(url).pathname`), without the query. Every adapter MUST derive it this way, so
   identical requests fingerprint identically across adapters. The WHATWG parser resolves
   dot segments and percent-encodes some characters; its result is used as is, with no
   further decoding.
3. `canonical query` is the query parsed with the WHATWG `application/x-www-form-urlencoded`
   parser, stably sorted by name (as `URLSearchParams.prototype.sort()` does, which keeps
   the relative order of repeated names), then serialised with the same format. An absent
   query and an empty query both produce the empty string.
4. `content type` is one byte `0x00` if `Content-Type` is absent, otherwise one byte `0x01`
   followed by the field value as received.
5. `header block` covers the headers in the route's fingerprint allowlist, which is empty by
   default. For each allowlisted name, in ascending order of its lowercase form, it contains
   `enc(lowercase name)` followed by `enc(0x00)` if the header is absent, or
   `enc(0x01 || combined field value)` if it is present. The combined value joins multiple
   field lines with `", "` (Section 5.3 of [RFC 9110][rfc9110]).
6. `body` is the raw request body bytes, before any content decoding or parsing.
7. The body MUST be buffered up to the route's fingerprint cap (default 1 MiB) and hashed
   once. If `Content-Length` exceeds the cap, or the bytes read exceed it, the middleware
   MUST stop reading and respond 413 immediately (row 15).

## 4. Behaviour

The middleware evaluates a request in this order and the first matching row applies:
row 1; then the key checks (rows 2 and 3); then the principal (row 4); then the body cap
(row 15); then the store (row 14); then the record state (rows 5 to 10). Rows 11, 12, 13 and
16 describe what happens after the handler runs.

| #  | Situation | Behaviour | Record |
| -- | --------- | --------- | ------ |
| 1  | Route or method not configured | Pass through untouched; any `Idempotency-Key` is ignored. | None. |
| 2  | Key required but missing | 400 [key-missing](#key-missing). | None. |
| 3  | Key malformed (not an sf-string, too long, or bad characters) | 400 [key-malformed](#key-malformed). | None. |
| 4  | No principal while scoping is required | 500 [configuration-error](#configuration-error), logged as a configuration error (fail closed). | None. |
| 5  | First request for the lookup key | The handler runs. A lease is acquired before it starts. | Created in flight; the response is stored per policy (section 5). |
| 6  | Completed key, same fingerprint | The stored response is replayed with `Idempotent-Replayed: true`. The handler does not run. | Unchanged. |
| 7  | Key exists (completed or in flight) with a different fingerprint | 422 [key-reused](#key-reused). | Unchanged. |
| 8  | In-flight key, lease valid, same fingerprint | 409 [in-flight](#in-flight) with `Retry-After` set to the remaining lease in whole seconds, rounded up (minimum 1). | Unchanged. |
| 9  | In-flight key, lease expired | The handler runs as a new attempt. | The lease is taken over and the fencing token incremented. A late complete, release or renew from the previous holder is rejected. |
| 10 | Key older than retention | Treated as a first request (row 5). | The old record is replaced. |
| 11 | Handler status is in the release set (default 408, 425, 429) | The handler's response is returned as-is. | Deleted, so the key can be retried. In transactional mode the handler's transaction is rolled back. 503 is not in the default set because it can follow a side effect. |
| 12 | Handler throws, or returns any other status (including 5xx) | The response is returned; a throw becomes a 500 problem (`about:blank`). | Completed: stored and replayed on retry, because side effects may have happened. |
| 13 | Handler throws in transactional mode | 500 problem (`about:blank`). | Rolled back together with the handler's writes; the key is free to retry. |
| 14 | Store unavailable | 503 [store-unavailable](#store-unavailable) with `Retry-After` (default 5 seconds, configurable per route) (fail closed). | None. |
| 15 | Request body over the fingerprint cap | 413 [body-too-large](#body-too-large). | None. |
| 16 | Client disconnects mid-request | The handler is not aborted. | The response is stored; a retry replays it. |

Further requirements:

- Rows 7 and 8: a request whose fingerprint differs from an in-flight record's is a reuse
  (row 7, 422), not a conflict (row 8): a 409 would invite a retry that can never succeed.
- Rows 7 and 9: row 7 takes precedence. A request with a different fingerprint MUST NOT take
  over an expired lease; the record keeps its fingerprint until retention ends.
- Rows 9 and 10: a live lease blocks row 10. A lease renewed repeatedly can outlast
  retention; while it is live, the record MUST NOT be replaced or purged.
- Row 9: fencing tokens MUST be compared and set atomically by the store on every complete,
  release and renew. A write carrying a stale token MUST change nothing and MUST be reported
  to the caller as fenced.
- Row 12 applies in lease mode, and in transactional mode for every outcome except a throw.
- Row 14: fail-open (running the handler without idemfence when the store is unavailable)
  MAY be enabled only as an explicit per-route opt-in. Every fail-open request MUST be
  logged at warn level.
- Row 15: the 413 response MUST carry `Connection: close`, and the middleware MUST NOT read
  the rest of the request body; an unbounded upload is never drained.
- Row 16: a client disconnect MUST NOT fire the handler's abort signal.

## 5. Responses

1. **Store-then-send.** The response MUST be stored, and the record completed, before any
   byte of it is sent. If the write fails after the handler has finished:
   - **Lease mode.** The middleware MUST retry the complete write up to 3 times with bounded
     backoff, no more than 1 second in total. A write rejected as fenced (row 9) is not
     retried. If the write still fails, the middleware MUST send the handler's actual
     response, log an error, and emit a `store_error` event. It MUST NOT respond 503 in this
     case: a 503 invites a retry, and once the lease expires that retry re-executes the
     handler (row 9), whereas the real response stops a well-behaved client from retrying.
     The record stays in flight until its lease expires. The residual risk is that the
     response is lost in transit and the client retries after the lease has expired, which
     runs the handler again. Handlers SHOULD guard downstream side effects with derived
     downstream keys, which are identical on every attempt.
   - **Transactional mode.** The record write is part of the handler's transaction, so a
     failure rolls back the record and the handler's writes together. The middleware MUST
     respond 503 [store-unavailable](#store-unavailable) with `Retry-After`. A retry is safe
     by construction.
2. Responses are buffered in full. Streaming responses are not supported on configured
   routes.
3. **Header denylist.** These response headers MUST NOT be stored or replayed:
   - hop-by-hop headers: `Connection`, `Keep-Alive`, `Proxy-Authenticate`,
     `Proxy-Authorization`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, and any header
     named in `Connection`;
   - `Content-Length`, which is recomputed on replay;
   - `Date`;
   - `Server-Timing`;
   - `traceparent` and `tracestate`;
   - `Set-Cookie`, unless the route explicitly allows it.
4. **Body cap.** Each route has a response body cap (default 1 MiB). If the body exceeds
   it, the original response is still sent in full and the record is still completed, with
   the status and stored headers but without the body. The middleware MUST NOT buffer more
   than the cap: once it is exceeded, the record is completed without the body (still before
   any byte is sent), and the client receives the buffered prefix followed by the rest of the
   handler's body as it streams. A metric and an error log entry MUST be emitted when the
   record is written. A replay of such a record returns the original status and stored
   headers (including `Location` and `ETag`), an empty body, and
   `Idempotent-Body-Omitted: true`.
5. **Unsupported streaming.** A handler response with a `text/event-stream` content type is
   replaced by a 500 problem (`about:blank`), which is stored and sent, and an error is
   logged.
6. Every replay carries `Idempotent-Replayed: true`, and its `Content-Length` is recomputed
   from the stored body.

## 6. Errors

Every error that idemfence generates is an `application/problem+json` body
([RFC 9457][rfc9457]) with `type`, `title`, `status` and `detail` members, sent with
`Link: <type-uri>; rel="describedby"`. The `type`, `title` and `status` of each problem are
defined below. The `detail` member is a human-readable explanation whose wording is not
part of this contract. No member or header of a problem response contains the client's
key. Responses for row 8 (in both modes), row 14, and
the transactional-mode 503 in section 5 also carry `Retry-After`.

Every `Retry-After` that idemfence emits is delay-seconds (Section 10.2.3 of
[RFC 9110][rfc9110]): a whole number of seconds, rounded up, with a minimum of 1. This
applies to the remaining lease (row 8, lease mode), the lock timeout (row 8, transactional
mode), and the configured store-unavailable delay (row 14, default 5 seconds).

A problem `type` URI is the documentation URL followed by `#` and the anchor below. The
documentation URL is the required `docsUrl` option and MUST use HTTPS. It points to the
operator's own published idempotency documentation, which Section 2.5.2 of the draft
requires every resource to publish. There is no default. idemfence ships
`docs/api-contract-template.md` (step 4.5), a template for that documentation containing
the anchors this section defines. A 500 for a handler throw (rows 12 and 13) uses the type
`about:blank`. `Link` is sent for every problem type defined in this section; it is omitted
for `about:blank`, which links to nothing.

### key-missing

Title: "Idempotency-Key is missing".

400. The route requires an `Idempotency-Key` and the request has none. Row 2.

### key-malformed

Title: "Idempotency-Key is malformed".

400. The `Idempotency-Key` is not an sf-string (or, with `keySyntax` `sf-string-or-raw`,
a valid raw key), is longer than the route's maximum, contains characters outside 0x20 to
0x7E, or is sent more than once. Row 3.

### key-reused

Title: "Idempotency-Key is already used".

422. The key was already used with a request whose fingerprint differs. Row 7.

### in-flight

Title: "A request is outstanding for this Idempotency-Key".

409. A request with the same key is still being processed. Retry after the number of
seconds in `Retry-After`. Row 8.

### store-unavailable

Title: "Idempotency store is unavailable".

503. The idempotency store could not be reached (row 14), or, in transactional mode, the
record could not be written with the handler's transaction (section 5). Retry after the
number of seconds in `Retry-After`.

### body-too-large

Title: "Request body is too large".

413. The request body exceeds the route's fingerprint cap. Row 15.

### configuration-error

Title: "Idempotency middleware is misconfigured".

500. idemfence is misconfigured, for example no principal is available while scoping is
required. The error is logged; the request is not processed. Row 4.

## 7. Modes

**Lease mode** (Postgres or Redis). The record is claimed with a lease and a fencing token.
The lease is renewed while the handler runs; every complete, release and renew is a
compare-and-set on the fencing token (row 9). All lease times MUST come from the store's
clock (Postgres `clock_timestamp()`, Redis `TIME`). Application server clocks MUST NOT be
used for lease decisions.

**Transactional mode** (Postgres). The record is written inside the handler's own database
transaction, so the record and the handler's writes commit or roll back together (rows 11
and 13). A concurrent request with the same key waits on the uncommitted record up to the
configured lock timeout, then receives 409 [in-flight](#in-flight) with `Retry-After` set to
that timeout in whole seconds, rounded up (minimum 1). Row 9 does not apply: a crashed
handler's transaction rolls back and frees the key.

## 8. Logging

Log entries emitted by idemfence carry only these fields: `keyHash` (the first 8 hex
characters of the lookup key, absent before the key is computed), `row` (the contract row),
`outcome` (a fixed label), `attempt` (a number), and for failures `error` (the error's name
and, when present, code). Entries MUST NOT contain raw client keys, request or response
bodies, header values, or error messages that may embed them.

## 9. Versioning

Any change to observable behaviour defined in this document is a semver-major change. This
includes status codes, headers, problem types, the evaluation order, and the lookup key and
fingerprint encodings. Editorial changes that do not alter behaviour are not.

## Appendix A. Test vectors

Implementations MUST reproduce these digests byte for byte. Digests are lowercase hex
SHA-256. Unless a vector says otherwise, the namespace is `idemfence`, the fingerprint
allowlist is empty, and no headers other than those listed are present.

### Lookup keys

| #  | principal | method | route template | client key | lookup key |
| -- | --------- | ------ | -------------- | ---------- | ---------- |
| L1 | `user-1` | `POST` | `/orders` | `8e03978e-40d5-43e8-bc93-6894a57f9324` | `20a9b317bd9314b4fe75ed1ca5b16184ee9ef404bd0ba1e92530fcfd6f3a9b61` |
| L2 | `ab` | `POST` | `c` | `k` | `9cf6d67825a4d64a64c4d609427cfed8482e4adb8be186740cbda0d6e3122848` |
| L3 | `a` | `POST` | `bc` | `k` | `cc56d56d0a9c41025aea2e0a6797ae9f6deeb96284a33725c53b5040a95dae9c` |

L2 and L3 concatenate to the same principal and route template text (`abc`); the length
prefixes keep them apart.

### Fingerprints

| #   | request | Content-Type | body | fingerprint |
| --- | ------- | ------------ | ---- | ----------- |
| F1  | `POST https://api.example.com/orders` | absent | empty | `7045f9603f3fb5cf7d8ce97d45b3c3e7ca1e3e8cb9623e156f86d94813e932dc` |
| F2  | `POST https://api.example.com/orders` | `application/json` | `{"amount":100}` | `05ded99e6efe8a94840e845b018f6ebe152ad66a8d145e7fd5eaad295107bd82` |
| F3  | `POST https://api.example.com/orders?b=2&a=1&a=0` | `application/json` | `{"amount":100}` | `70e9344b7b6d5933a76b74814e0bce5ff5def8644208cf90478d925fe43aa078` |
| F3' | `POST https://api.example.com/orders?a=1&b=2&a=0` | `application/json` | `{"amount":100}` | `70e9344b7b6d5933a76b74814e0bce5ff5def8644208cf90478d925fe43aa078` |
| F4a | `POST https://api.example.com/orders` | absent | `x` | `41e855383497f6c43817e7a16cafe2df3ff6f8d3022993053c11beacf8bbf0f0` |
| F4b | `POST https://api.example.com/orders` | present, empty | `x` | `2b9ce6afb919ab31dcba4268cff7737e50d752d2f92ef23f92d720f306213516` |
| F5  | `POST https://api.example.com/orders` with `X-Tenant-ID: t-42`; allowlist `x-tenant-id`, `accept-language` | `application/json` | `{"amount":100}` | `709bce267e32c52c842bf96abd3c6e4f01aa3a789c9ce2fef3f852f0028b4ceb` |
| F6  | `PUT https://api.example.com/orders/../orders/%7e42` | `application/json` | `{"amount":100}` | `8cb4f171b055b24098db98c22e5e797c5f61700f630f847353624bbc9ee0b8e4` |

Notes:

- F3 and F3' differ only in query order and share one digest: both canonical queries are
  `a=1&a=0&b=2` (repeated names keep their relative order).
- F4a and F4b differ only in an absent versus an empty `Content-Type`.
- In F5, `accept-language` is allowlisted but absent, and is encoded as absent.
- In F6, the WHATWG pathname is `/orders/%7e42`.
- Bodies are the exact bytes shown, without a trailing newline.

## References

- [The Idempotency-Key HTTP Header Field][draft]: J. Jena, S. Dalal, D. Tishkin,
  draft-ietf-httpapi-idempotency-key-header-08, 22 October 2026.
- [RFC 2119][rfc2119], [RFC 8174][rfc8174]: Key words for use in RFCs to indicate
  requirement levels.
- [RFC 9110][rfc9110]: HTTP Semantics.
- [RFC 9457][rfc9457]: Problem Details for HTTP APIs.
- [RFC 9651][rfc9651]: Structured Field Values for HTTP (obsoletes RFC 8941).
- [WHATWG URL Standard][whatwg-url]: `application/x-www-form-urlencoded` and
  `URLSearchParams`.

[draft]: https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-08
[rfc2119]: https://www.rfc-editor.org/rfc/rfc2119
[rfc8174]: https://www.rfc-editor.org/rfc/rfc8174
[rfc9110]: https://www.rfc-editor.org/rfc/rfc9110
[rfc9457]: https://www.rfc-editor.org/rfc/rfc9457
[rfc9651]: https://www.rfc-editor.org/rfc/rfc9651
[whatwg-url]: https://url.spec.whatwg.org/#application/x-www-form-urlencoded
