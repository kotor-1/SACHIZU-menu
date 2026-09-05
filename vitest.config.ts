import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./tests/db-path";

export default defineConfig({
  resolve: {
    // tsconfig.json の paths ("@/*" → "src/*") をテストでもそのまま使う。
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
    },
    globalSetup: ["./tests/global-setup.ts"],
    // Repository テストは同じ SQLite ファイルを共有するため、
    // ファイル単位の並列実行にすると "database is locked" が起こりうる。
    // テスト件数もまだ小さいため、確実さを優先して直列実行にする。
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
