import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertIsolatedDatabaseUrl, assertNotOriginalDatabasePath, assertTestDatabaseEnvironment } from "../support/isolated-database";

let area: string;
let isolation: { isolatedRoot: string; originalWorkspaceRoot: string };
beforeAll(() => {
  area = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "database-guard-")));
  isolation = { isolatedRoot: path.join(area, "isolated"), originalWorkspaceRoot: path.join(area, "original") };
  fs.mkdirSync(isolation.isolatedRoot); fs.mkdirSync(isolation.originalWorkspaceRoot);
  fs.mkdirSync(path.join(isolation.originalWorkspaceRoot, "prisma"));
  fs.writeFileSync(path.join(isolation.originalWorkspaceRoot, "prisma/test.db"), "protected fixture bytes");
});
afterAll(() => fs.rmSync(area, { recursive: true, force: true }));
const check = (url: string | undefined) => assertIsolatedDatabaseUrl(url, isolation);

describe("isolated SQLite safety before any destructive setup", () => {
  it("allows only an explicit disposable absolute SQLite path", () => {
    const file = path.join(isolation.isolatedRoot, "main-suite.sqlite");
    expect(check(`file:${file}`)).toBe(file);
    expect(fs.existsSync(file)).toBe(false);
  });
  it.each([undefined, "", "file:./dev.db", "file:./test.db", "file:prisma/test.db", "file::memory:", "postgresql://example/db", "file://remote/db", "file:/tmp/x?mode=rw", "file:/tmp/x#fragment", "file:/tmp/%00bad"])("denies missing, relative or ambiguous URL %s", url => {
    expect(() => check(url)).toThrow();
  });
  it.each(["dev.db", "test.db", "test.db-wal", "dev.db-shm"])("denies protected database basename %s even in temporary storage", name => {
    expect(() => check(`file:${path.join(isolation.isolatedRoot, name)}`)).toThrow("ORIGINAL_DATABASE_PATH_FORBIDDEN");
  });
  it("rejects original paths without opening or changing original fixture bytes", () => {
    const original = path.join(isolation.originalWorkspaceRoot, "prisma/test.db");
    const before = fs.statSync(original);
    expect(() => assertNotOriginalDatabasePath(original, isolation.originalWorkspaceRoot)).toThrow();
    expect(() => check(`file:${original}`)).toThrow();
    expect(fs.readFileSync(original, "utf8")).toBe("protected fixture bytes");
    expect(fs.statSync(original).mtimeMs).toBe(before.mtimeMs);
  });
  it("rejects sibling-prefix and dot-segment escapes", () => {
    expect(() => check(`file:${isolation.isolatedRoot}-other/a.sqlite`)).toThrow("DATABASE_OUTSIDE_ISOLATION_ROOT");
    expect(() => check(`file:${isolation.isolatedRoot}/../outside.sqlite`)).toThrow("DATABASE_OUTSIDE_ISOLATION_ROOT");
  });
  it("resolves a symlink into original storage and rejects it", () => {
    const alias = path.join(isolation.isolatedRoot, "alias");
    fs.symlinkSync(isolation.originalWorkspaceRoot, alias);
    expect(() => check(`file:${alias}/prisma/test.db`)).toThrow("ORIGINAL_DATABASE_PATH_FORBIDDEN");
    expect(() => check(`file:${alias}/not-created.sqlite`)).toThrow("ORIGINAL_DATABASE_PATH_FORBIDDEN");
  });
  it("rejects a missing explicit root, broad temporary root or directory as DB", () => {
    const file = `file:${isolation.isolatedRoot}/db.sqlite`;
    expect(() => assertIsolatedDatabaseUrl(file, { ...isolation, isolatedRoot: "" })).toThrow();
    expect(() => assertIsolatedDatabaseUrl(file, { ...isolation, isolatedRoot: os.tmpdir() })).toThrow();
    const dir = path.join(isolation.isolatedRoot, "directory.sqlite"); fs.mkdirSync(dir);
    expect(() => check(`file:${dir}`)).toThrow("ISOLATION_DATABASE_NOT_FILE");
  });
  it("rejects an isolated non-database file before setup can delete it", () => {
    const filename = path.join(isolation.isolatedRoot, "package.json");
    fs.writeFileSync(filename, "{\"protected\":true}");
    expect(() => check(`file:${filename}`)).toThrow("ISOLATION_SQLITE_EXTENSION_REQUIRED");
    expect(fs.readFileSync(filename, "utf8")).toBe("{\"protected\":true}");
  });
  it("fails closed on missing environment and accepts fully specified isolated environment", () => {
    expect(() => assertTestDatabaseEnvironment({})).toThrow("EXPLICIT_TEST_ISOLATION_REQUIRED");
    expect(() => assertTestDatabaseEnvironment({ SACHIZU_TEST_ISOLATION_ROOT: isolation.isolatedRoot, SACHIZU_ORIGINAL_WORKSPACE_ROOT: isolation.originalWorkspaceRoot })).toThrow("ISOLATED_DATABASE_URL_REQUIRED");
    const file = path.join(isolation.isolatedRoot, "environment.sqlite");
    expect(assertTestDatabaseEnvironment({ DATABASE_URL: `file:${file}`, SACHIZU_TEST_ISOLATION_ROOT: isolation.isolatedRoot, SACHIZU_ORIGINAL_WORKSPACE_ROOT: isolation.originalWorkspaceRoot })).toBe(file);
  });
});
