import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Silence console output from the modules under test so test output is clean.
    // Individual tests can still use vi.spyOn(console, ...) if they need it.
    globals: false,
  },
});
