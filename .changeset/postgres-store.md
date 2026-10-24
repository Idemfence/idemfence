---
"idemfence": minor
---

Add the `idemfence/postgres` subpath: `postgresStore({ pool, schema? })` is a lease-mode store on PostgreSQL that takes the caller's `pg.Pool`, with the schema shipped as `migrations/001_init.sql`. `pg` is an optional peer dependency. Store failures that are not a normal outcome throw `IdemfenceStoreError` with a stable `code` (`SCHEMA_VERSION_MISMATCH`, `SCHEMA_NAME_INVALID`, `BEGIN_RACE_EXHAUSTED`); the `Store`, `BeginResult` and `StoredResponse` types are exported from the package root.
