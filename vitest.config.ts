import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/*.{test,spec}.{js,ts,jsx,tsx}"],
    coverage: {
      include: ["lib/fast-tracker.ts", "lib/tracker.ts"],
    },
  },
});
