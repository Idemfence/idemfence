// Tests the PACKED idemfence tarball the way a consumer would install it. Node built-ins only.
// Run from the repository root after `pnpm build`:
//   node scripts/artifact-test.mjs
// Checks: the `npm pack --dry-run` file list matches the expected set exactly; ESM imports and
// CommonJS require() of every public entry point work from a fresh project; the migration SQL
// resolves through its export path; LICENSE and NOTICE ship.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "packages", "idemfence");
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const EXPECTED_FILES = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "package.json",
  "migrations/001_init.sql",
  ...[
    "config",
    "engine",
    "fetch",
    "hash",
    "index",
    "key",
    "problem",
    "store",
    "stores/postgres/index",
    "stores/postgres/transaction",
  ].flatMap((m) => [`dist/${m}.d.ts`, `dist/${m}.js`, `dist/${m}.js.map`]),
].sort();

let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures += 1;
};

const work = mkdtempSync(join(tmpdir(), "idemfence-artifact-"));
try {
  // 1. The file list, from npm's own dry run (prepack runs first so LICENSE/NOTICE/README exist).
  run("node", [join(root, "scripts", "prepack-copy.mjs")], pkgDir);
  const dry = JSON.parse(run("npm", ["pack", "--dry-run", "--json"], pkgDir));
  const files = dry[0].files.map((f) => f.path).sort();
  const missing = EXPECTED_FILES.filter((f) => !files.includes(f));
  const extra = files.filter((f) => !EXPECTED_FILES.includes(f));
  check(
    missing.length === 0 && extra.length === 0,
    `npm pack --dry-run lists exactly the ${EXPECTED_FILES.length} expected files` +
      (missing.length ? `; missing: ${missing.join(", ")}` : "") +
      (extra.length ? `; extra: ${extra.join(", ")}` : ""),
  );

  // 2. Pack for real and install the tarball into a fresh project.
  const tarballDir = join(work, "tarball");
  run("pnpm", ["pack", "--pack-destination", tarballDir], pkgDir);
  const tarball = join(
    tarballDir,
    readdirSync(tarballDir).find((f) => f.endsWith(".tgz")),
  );
  const project = join(work, "consumer");
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    '{ "name": "consumer", "private": true }',
  );
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--silent", tarball],
    project,
  );
  const installed = join(project, "node_modules", "idemfence");
  check(
    existsSync(join(installed, "LICENSE")),
    "LICENSE is installed with the package",
  );
  check(
    existsSync(join(installed, "NOTICE")),
    "NOTICE is installed with the package",
  );
  check(
    existsSync(join(installed, "README.md")),
    "README.md is installed with the package",
  );

  // 3. ESM imports of every public entry point and the migration SQL through its export path.
  const esm = `
    import { readFileSync } from "node:fs";
    import { fileURLToPath } from "node:url";
    const root = await import("idemfence");
    const fetchAdapter = await import("idemfence/fetch");
    const postgres = await import("idemfence/postgres");
    const sql = readFileSync(fileURLToPath(import.meta.resolve("idemfence/postgres/migrations/001_init.sql")), "utf8");
    console.log(JSON.stringify({
      root: Object.keys(root).sort(),
      fetch: Object.keys(fetchAdapter).sort(),
      postgres: Object.keys(postgres).sort(),
      sqlHasRecords: sql.includes("CREATE TABLE idemfence_records"),
    }));
  `;
  const esmOut = JSON.parse(
    run("node", ["--input-type=module", "-e", esm], project),
  );
  check(
    JSON.stringify(esmOut) ===
      JSON.stringify({
        root: [
          "IdemfenceConfigError",
          "IdemfenceFencedError",
          "IdemfenceStoreError",
          "createIdemfence",
        ],
        fetch: ["idempotent"],
        postgres: ["IdemfenceStoreError", "postgresStore", "withTransaction"],
        sqlHasRecords: true,
      }),
    `ESM: idemfence, idemfence/fetch, idemfence/postgres and the migration SQL resolve (${JSON.stringify(esmOut)})`,
  );

  // 4. CommonJS require() of the same entry points (require(esm) on Node >= 22.12).
  const cjs = `
    const fs = require("node:fs");
    const root = require("idemfence");
    const fetchAdapter = require("idemfence/fetch");
    const postgres = require("idemfence/postgres");
    const sql = fs.readFileSync(require.resolve("idemfence/postgres/migrations/001_init.sql"), "utf8");
    console.log(JSON.stringify({
      createIdemfence: typeof root.createIdemfence,
      idempotent: typeof fetchAdapter.idempotent,
      postgresStore: typeof postgres.postgresStore,
      sqlHasRecords: sql.includes("CREATE TABLE idemfence_records"),
    }));
  `;
  const cjsOut = JSON.parse(run("node", ["-e", cjs], project));
  check(
    cjsOut.createIdemfence === "function" &&
      cjsOut.idempotent === "function" &&
      cjsOut.postgresStore === "function" &&
      cjsOut.sqlHasRecords === true,
    `CommonJS: require() of all three entry points and the migration SQL works (${JSON.stringify(cjsOut)})`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} artifact check(s) failed`);
  process.exit(1);
}
console.log("artifact tests passed");
