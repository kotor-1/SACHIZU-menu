import { defineConfig } from "vitest/config";

/** DB-free domain suite. The default Vitest setup recreates prisma/test.db. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/domain/**/*.test.ts"],
    fileParallelism: false,
  },
});
