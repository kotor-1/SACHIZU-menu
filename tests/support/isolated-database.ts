import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DatabaseIsolation = { isolatedRoot: string; originalWorkspaceRoot: string };
const within = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + path.sep);

/** Resolve existing symlinks even when the final disposable DB has not been created yet. */
function canonicalPath(filename: string): string {
  let parent = path.resolve(filename);
  const tail: string[] = [];
  while (!fs.existsSync(parent)) {
    try { if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("ISOLATION_SYMLINK_INVALID"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next = path.dirname(parent);
    if (next === parent) throw new Error("ISOLATION_PATH_INVALID");
    tail.unshift(path.basename(parent)); parent = next;
  }
  return path.join(fs.realpathSync(parent), ...tail);
}

export function assertNotOriginalDatabasePath(databasePath: string, originalWorkspaceRoot: string): string {
  if (!path.isAbsolute(databasePath) || !path.isAbsolute(originalWorkspaceRoot)) throw new Error("ISOLATION_ABSOLUTE_PATH_REQUIRED");
  const resolved = canonicalPath(databasePath);
  const original = canonicalPath(originalWorkspaceRoot);
  if (within(original, resolved) || /^(dev|test)\.db(?:-(journal|wal|shm))?$/i.test(path.basename(resolved))) throw new Error("ORIGINAL_DATABASE_PATH_FORBIDDEN");
  return resolved;
}

/** Fail closed before a SQLite connection, deletion, migration or restore. Never supplies a default URL. */
export function assertIsolatedDatabaseUrl(url: string | undefined, isolation: DatabaseIsolation): string {
  if (!url || !url.startsWith("file:") || url.startsWith("file://") || /[?#\0]/.test(url)) throw new Error("ISOLATED_DATABASE_URL_REQUIRED");
  let filename: string;
  try { filename = decodeURIComponent(url.slice(5)); } catch { throw new Error("ISOLATED_DATABASE_URL_REQUIRED"); }
  if (!filename || /[?#\0]/.test(filename) || !path.isAbsolute(filename)) throw new Error("ISOLATION_ABSOLUTE_PATH_REQUIRED");
  if (!path.isAbsolute(isolation.isolatedRoot) || !fs.existsSync(isolation.isolatedRoot)) throw new Error("ISOLATION_ROOT_REQUIRED");
  const root = fs.realpathSync(isolation.isolatedRoot);
  const temporaryRoots = [...new Set([os.tmpdir(), "/tmp"].filter(p => fs.existsSync(p)).map(p => fs.realpathSync(p)))];
  if (temporaryRoots.includes(root) || !temporaryRoots.some(p => within(p, root)) || !fs.statSync(root).isDirectory()) throw new Error("ISOLATION_TEMP_ROOT_REQUIRED");
  const resolved = assertNotOriginalDatabasePath(filename, isolation.originalWorkspaceRoot);
  if (resolved === root || !within(root, resolved)) throw new Error("DATABASE_OUTSIDE_ISOLATION_ROOT");
  if (!/\.(db|sqlite)$/i.test(resolved)) throw new Error("ISOLATION_SQLITE_EXTENSION_REQUIRED");
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isFile()) throw new Error("ISOLATION_DATABASE_NOT_FILE");
  return resolved;
}

export function assertTestDatabaseEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (!env.SACHIZU_TEST_ISOLATION_ROOT || !env.SACHIZU_ORIGINAL_WORKSPACE_ROOT) throw new Error("EXPLICIT_TEST_ISOLATION_REQUIRED");
  return assertIsolatedDatabaseUrl(env.DATABASE_URL, { isolatedRoot: env.SACHIZU_TEST_ISOLATION_ROOT, originalWorkspaceRoot: env.SACHIZU_ORIGINAL_WORKSPACE_ROOT });
}
