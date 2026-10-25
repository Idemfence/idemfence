// prepack for packages/idemfence: copies the repository's LICENSE, NOTICE and README.md into
// the package so they ship in the tarball (Apache-2.0 requires NOTICE to accompany the work).
// The copies are gitignored. Node built-ins only.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["LICENSE", "NOTICE", "README.md"]) {
  copyFileSync(join(root, name), join(process.cwd(), name));
}
