---
"idemfence": minor
---

Add `IdemfenceConfigError`, thrown at construction when options are invalid. Each failure has a stable `code`: `STORE_INVALID`, `SCOPE_MISSING`, `SECRET_TOO_SHORT`, `DOCS_URL_NOT_HTTPS`, `DURATION_INVALID`, `LEASE_NOT_SHORTER_THAN_RETENTION`, `KEY_MAX_LENGTH_INVALID`, `BODY_CAP_INVALID`, `RELEASE_STATUS_INVALID` and `WEBCRYPTO_MISSING`. Error messages name the offending option and never include secret values.
