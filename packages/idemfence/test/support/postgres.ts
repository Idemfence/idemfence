import { readFile } from "node:fs/promises";
import pg from "pg";

const MIGRATION = new URL("../../migrations/001_init.sql", import.meta.url);

/** The test database URL; throws (failing the suite) when it is unset. */
export function databaseUrl(): string {
  const url = process.env.IDEMFENCE_TEST_DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "IDEMFENCE_TEST_DATABASE_URL is not set. These tests need a real Postgres; see CONTRIBUTING.md.",
    );
  }
  return url;
}

/** Applies the migration to `schema` on a dedicated connection, so pooled sessions keep their search_path. */
export async function migrate(url: string, schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(await readFile(MIGRATION, "utf8"));
  } finally {
    await client.end();
  }
}

/** Connection fields of `url`, for pools that need to override the user. */
export function connectionFields(url: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    database: parsed.pathname.replace(/^\//, ""),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}
