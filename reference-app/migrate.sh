#!/bin/sh
# One-shot migration runner for compose: applies idemfence's schema and the app's table once.
# The app itself never migrates.
set -eu
applied=$(psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.idemfence_meta') IS NOT NULL")
if [ "$applied" = "t" ]; then
  echo "migrations already applied; nothing to do"
  exit 0
fi
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /migrations/001_init.sql -f /migrations/002_orders.sql
echo "migrations applied"
