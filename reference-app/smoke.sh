#!/usr/bin/env bash
# Smoke test against a running reference app: a keyed POST, its replay, and the order count.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT:-3000}}"
KEY="smoke-$(date +%s)-$RANDOM"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

post() {
  curl -sS -o "$tmp/$1.body" -D "$tmp/$1.headers" -w '%{http_code}' -X POST "$BASE_URL/orders" \
    -H 'Content-Type: application/json' -H 'X-Principal: smoke' \
    -H "Idempotency-Key: \"$KEY\"" --data '{"item":"widget"}'
}

status="$(post first)"
[ "$status" = "201" ] || { echo "first POST: expected 201, got $status"; cat "$tmp/first.body"; exit 1; }
echo "first POST: 201 $(cat "$tmp/first.body")"

status="$(post second)"
[ "$status" = "201" ] || { echo "replay: expected 201, got $status"; cat "$tmp/second.body"; exit 1; }
cmp -s "$tmp/first.body" "$tmp/second.body" || { echo "replay body differs from the first response"; exit 1; }
grep -qi '^idempotent-replayed: true' "$tmp/second.headers" || { echo "replay lacks Idempotent-Replayed: true"; cat "$tmp/second.headers"; exit 1; }
echo "replay: 201, byte-identical, Idempotent-Replayed: true"

count="$(curl -sS "$BASE_URL/orders/count")"
[ "$count" = '{"count":1}' ] || { echo "count: expected {\"count\":1}, got $count"; exit 1; }
echo "count: $count"
echo "smoke test passed"
