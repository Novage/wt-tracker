import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/*.{test,spec}.{js,ts,jsx,tsx}"],
    coverage: {
      include: ["src/fast-tracker.ts", "src/tracker.ts"],
    },
  },
});
