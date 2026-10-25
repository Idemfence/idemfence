import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Fails any test file in which a timer delay overflowed (TimeoutOverflowWarning).
    setupFiles: ["./packages/idemfence/test/support/no-timer-overflow.ts"],
  },
});
