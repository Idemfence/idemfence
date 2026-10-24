import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const distConfig = fileURLToPath(new URL("../dist/config.js", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "idemfence-webcrypto-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// Node 22 documents --no-experimental-global-webcrypto to remove globalThis.crypto. Node 23
// removed that flag (the global became stable) and documents no replacement, so on newer
// lines a preload passed with --import deletes the global before the package is loaded.
function runtimeWithoutWebCrypto(): string[] {
  if (
    process.allowedNodeEnvironmentFlags.has(
      "--no-experimental-global-webcrypto",
    )
  ) {
    return ["--no-experimental-global-webcrypto"];
  }
  const preload = join(workDir, "remove-webcrypto.mjs");
  writeFileSync(preload, "delete globalThis.crypto;\n");
  return ["--import", pathToFileURL(preload).href];
}

describe("WEBCRYPTO_MISSING on the real runtime", () => {
  it("is thrown by the built package when globalThis.crypto is absent", () => {
    expect(existsSync(distConfig), "run `pnpm build` before `pnpm test`").toBe(
      true,
    );

    const script = join(workDir, "resolve.mjs");
    writeFileSync(
      script,
      `const { resolveConfig } = await import(${JSON.stringify(pathToFileURL(distConfig).href)});
const result = { crypto: typeof globalThis.crypto };
try {
  resolveConfig({
    store: { begin() {}, renew() {}, complete() {}, release() {} },
    scope: () => "principal-1",
    secret: "test-secret-0123456789-abcdefghijklmnop",
    docsUrl: "https://example.com/docs/idempotency",
  });
  result.error = null;
} catch (error) {
  result.error = { name: error.name, code: error.code };
}
console.log(JSON.stringify(result));
`,
    );

    const output = execFileSync(
      process.execPath,
      [...runtimeWithoutWebCrypto(), script],
      {
        encoding: "utf8",
      },
    );
    expect(JSON.parse(output)).toStrictEqual({
      crypto: "undefined",
      error: { name: "IdemfenceConfigError", code: "WEBCRYPTO_MISSING" },
    });
  });
});
