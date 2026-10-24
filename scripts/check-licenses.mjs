// Fails if any installed dependency (direct or transitive) has a license outside the allowlist.
// Uses Node built-ins only. Run from the repository root after `pnpm install`.
import { execFileSync } from "node:child_process";

const ALLOWED = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "BlueOak-1.0.0",
  "MPL-2.0",
]);

// SPDX expression policy:
// - an expression containing AND or WITH passes only if every identifier is allowed;
// - otherwise an expression containing OR passes if any identifier is allowed;
// - a single identifier passes if it is allowed;
// - a missing or empty license fails.
function isAllowed(expression) {
  if (typeof expression !== "string" || expression.trim() === "") {
    return false;
  }
  const tokens = expression
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter((token) => token !== "");
  const operators = new Set(["AND", "OR", "WITH"]);
  const ids = tokens.filter((token) => !operators.has(token.toUpperCase()));
  const ops = new Set(
    tokens
      .map((token) => token.toUpperCase())
      .filter((token) => operators.has(token)),
  );
  if (ids.length === 0) {
    return false;
  }
  if (ops.has("AND") || ops.has("WITH")) {
    return ids.every((id) => ALLOWED.has(id));
  }
  if (ops.has("OR")) {
    return ids.some((id) => ALLOWED.has(id));
  }
  return ids.length === 1 && ALLOWED.has(ids[0]);
}

function main() {
  const output = execFileSync(
    "pnpm",
    ["licenses", "list", "--json", "--recursive"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const byLicense = JSON.parse(output);

  const checked = new Set();
  const offending = [];
  for (const [groupLicense, packages] of Object.entries(byLicense)) {
    for (const pkg of packages) {
      const license = pkg.license ?? groupLicense;
      for (const version of pkg.versions ?? ["unknown"]) {
        const id = `${pkg.name}@${version}`;
        checked.add(id);
        if (!isAllowed(license)) {
          offending.push({ id, license: license || "(missing)" });
        }
      }
    }
  }

  if (checked.size === 0) {
    console.error(
      "No packages reported by `pnpm licenses list`; refusing to pass.",
    );
    process.exit(1);
  }

  if (offending.length > 0) {
    console.error(
      `${offending.length} of ${checked.size} packages have a license outside the allowlist:`,
    );
    for (const { id, license } of offending.sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      console.error(`  ${id}: ${license}`);
    }
    console.error(`Allowed: ${[...ALLOWED].join(", ")}`);
    process.exit(1);
  }

  console.log(`All ${checked.size} packages have an allowed license.`);
}

main();
