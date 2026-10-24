# idemfence

idemfence is a drop-in HTTP middleware for TypeScript that implements the IETF
[Idempotency-Key HTTP header field draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/).
It fingerprints each request so a reused key with a different payload is rejected,
replays the stored response for a retried request, detects a retry that arrives while
the original is still in flight and answers it with a conflict, and uses fencing tokens
so a worker that crashes or stalls mid-request cannot later overwrite the result of the
one that took over.

**Status: pre-release — no package published yet.**

The behaviour idemfence will implement is specified in [docs/contract.md](docs/contract.md).

## License

idemfence is licensed under the [Apache License, Version 2.0](LICENSE).
See [NOTICE](NOTICE) for attribution.
