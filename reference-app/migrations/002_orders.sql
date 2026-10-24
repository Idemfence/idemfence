-- The reference app's own table. idemfence's schema comes from
-- packages/idemfence/migrations/001_init.sql, applied first.
CREATE TABLE orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
