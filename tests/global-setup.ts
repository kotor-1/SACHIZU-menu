import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { TEST_DATABASE_URL, TEST_DB_PATH } from "./db-path";
import { assertTestDatabaseEnvironment } from "./support/isolated-database";

/**
 * vitest の globalSetup。テストスイート全体で 1 回だけ実行される。
 *
 * テスト用の SQLite ファイルを作り直し、schema.prisma の内容を
 * `prisma db push` で反映する。マイグレーション履歴は不要な使い捨て DB なので
 * migrate ではなく db push を使う。
 */
export default async function setup() {
  if (assertTestDatabaseEnvironment() !== TEST_DB_PATH) throw new Error("TEST_DATABASE_PATH_CHANGED");
  for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    const file = TEST_DB_PATH + suffix;
    if (fs.existsSync(file)) fs.rmSync(file);
  }

  execFileSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: "inherit",
    },
  );
}
