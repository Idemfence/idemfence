#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  ConfigError,
  formatHuman,
  parseCliArgs,
  runContractGroup,
  summarize,
  USAGE,
  validateConfig,
} from "./index.js";

async function main(): Promise<number> {
  let options: ReturnType<typeof parseCliArgs>;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `idemfence-conformance: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    console.error(USAGE);
    return 2;
  }
  if ("help" in options) {
    console.log(USAGE);
    return 0;
  }

  let config: ReturnType<typeof validateConfig>;
  try {
    config = validateConfig(JSON.parse(await readFile(options.config, "utf8")));
  } catch (error) {
    const message =
      error instanceof ConfigError
        ? error.message
        : `cannot read ${options.config}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`idemfence-conformance: ${message}`);
    return 2;
  }

  console.error(
    `idemfence-conformance: running the Contract group against ${options.url}; every scenario creates real side effects in the target.`,
  );
  const results = await runContractGroup(options.url, config, {
    only: options.only,
  });
  const summary = summarize(results, options.requireAll);
  if (options.json) {
    console.log(
      JSON.stringify({ url: options.url, results, summary }, null, 2),
    );
  } else {
    console.log(formatHuman(options.url, results, summary));
  }
  return summary.ok ? 0 : 1;
}

process.exitCode = await main();
