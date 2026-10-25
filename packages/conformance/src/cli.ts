#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  ConfigError,
  formatConcurrency,
  formatCrash,
  formatHuman,
  parseCliArgs,
  runConcurrencyGroup,
  runContractGroup,
  runCrashGroup,
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

  // Lease is the default; only a transactional target is named, so lease output is unchanged.
  const transactional = config.mode === "transactional";
  const groupName = {
    contract: "Contract",
    concurrency: "Concurrency",
    crash: "Crash",
  }[options.group];
  console.error(
    `idemfence-conformance: running the ${groupName} group against ${options.url}${transactional ? " in transactional mode" : ""}; every scenario creates real side effects in the target.`,
  );
  if (options.group === "crash") {
    let result: Awaited<ReturnType<typeof runCrashGroup>>;
    try {
      result = await runCrashGroup(options.url, config);
    } catch (error) {
      console.error(
        `idemfence-conformance: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 2;
    }
    console.log(
      options.json
        ? JSON.stringify({ url: options.url, ...result }, null, 2)
        : formatCrash(options.url, result),
    );
    return result.ok ? 0 : 1;
  }
  if (options.group === "concurrency") {
    let result: Awaited<ReturnType<typeof runConcurrencyGroup>>;
    try {
      result = await runConcurrencyGroup(options.url, config, {
        iterations: options.iterations,
        concurrency: options.concurrency,
      });
    } catch (error) {
      console.error(
        `idemfence-conformance: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 2;
    }
    console.log(
      options.json
        ? JSON.stringify({ url: options.url, ...result }, null, 2)
        : formatConcurrency(options.url, result),
    );
    return result.ok ? 0 : 1;
  }

  const results = await runContractGroup(options.url, config, {
    only: options.only,
  });
  const summary = summarize(results, options.requireAll);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          url: options.url,
          ...(transactional ? { mode: config.mode } : {}),
          results,
          summary,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatHuman(options.url, results, summary, config.mode));
  }
  return summary.ok ? 0 : 1;
}

process.exitCode = await main();
