-- idemfence Postgres store, schema version 1.
-- Apply with the search_path set to the schema the store is configured with (default: public).
-- Tables are LOGGED on purpose: Postgres empties UNLOGGED tables after a crash, which would
-- discard in-flight leases and completed responses.

CREATE TABLE idemfence_meta (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version integer NOT NULL
);

INSERT INTO idemfence_meta (version) VALUES (1);

-- Fencing tokens come from one sequence so that a token is never reused, even after a record
-- is deleted (release or purge) and recreated: a holder of a stale token can never match a
-- newer record.
CREATE SEQUENCE idemfence_fencing_token_seq AS bigint;

CREATE TABLE idemfence_records (
    lookup_key bytea PRIMARY KEY CHECK (octet_length(lookup_key) = 32),
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    state text NOT NULL CHECK (state IN ('in_flight', 'completed')),
    fencing_token bigint NOT NULL,
    lease_expires_at timestamptz,
    response_status smallint,
    response_headers jsonb,
    response_body bytea,
    body_omitted boolean NOT NULL DEFAULT false,
    attempts integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL,
    completed_at timestamptz,
    expires_at timestamptz NOT NULL
);

CREATE INDEX idemfence_records_expires_at_idx ON idemfence_records (expires_at);
