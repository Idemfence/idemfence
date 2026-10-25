// Loaded before every test file (vitest.config.ts): fails the file if any timer in it was
// given a delay above 2147483647 ms, which Node runs after 1 ms instead and reports as a
// TimeoutOverflowWarning.
import { afterAll } from "vitest";

const overflows: string[] = [];
process.on("warning", (warning) => {
  if (warning.name === "TimeoutOverflowWarning") {
    overflows.push(warning.message);
  }
});

afterAll(async () => {
  // Node emits warnings on a later tick; let any still pending arrive first.
  await new Promise((resolve) => setImmediate(resolve));
  if (overflows.length > 0) {
    throw new Error(`TimeoutOverflowWarning emitted: ${overflows.join("; ")}`);
  }
});
