---
"idemfence": minor
---

Add the `keySyntax` option: `"sf-string"` (default) accepts only a Structured Field String key, and `"sf-string-or-raw"` also accepts an unquoted key of printable ASCII without spaces, quotes or backslashes, so `abc` and `"abc"` are the same key. Invalid values throw `IdemfenceConfigError` with code `KEY_SYNTAX_INVALID`.
