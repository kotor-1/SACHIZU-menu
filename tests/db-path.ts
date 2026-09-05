import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * テスト専用の SQLite ファイルパス。
 *
 * vitest.config.ts（DATABASE_URL の設定）と tests/global-setup.ts（db push）
 * の両方から同じ値を参照する必要があるため、1 箇所にまとめてある。
 * 本番用の prisma/dev.db とは別ファイルなので、テスト実行が開発データを壊さない。
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export const TEST_DB_PATH = path.resolve(here, "../prisma/test.db");
export const TEST_DATABASE_URL = `file:${TEST_DB_PATH}`;
