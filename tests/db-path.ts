import { assertTestDatabaseEnvironment } from "./support/isolated-database";

/**
 * テスト専用の SQLite ファイルパス。
 *
 * vitest.config.ts（DATABASE_URL の設定）と tests/global-setup.ts（db push）
 * の両方から同じ値を参照する必要があるため、1 箇所にまとめてある。
 * 明示指定した一時領域だけを許可する。元 prisma/test.db を再作成してはならない。
 * DATABASE_URL と isolation/original root が未指定なら、削除前に停止する。
 */
export const TEST_DB_PATH = assertTestDatabaseEnvironment();
export const TEST_DATABASE_URL = `file:${TEST_DB_PATH}`;
