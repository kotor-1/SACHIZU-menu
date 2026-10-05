import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalVideoSourceBindingResolver } from "@/infra/exercise/local-video-source-binding";

// Deliberately plain bytes: these tests never decode video, invoke an analyzer,
// connect to a database, or contact an external service.
const originalBytes = Buffer.from("offline synthetic source bytes A");
const changedBytes = Buffer.from("offline synthetic source bytes B");
const ownerId = "source-owner";
const exerciseId = "source-exercise";
const sourceVideoId = "source-video";
const sourceUrl = "https://example.test/original-video";
type Asset = { id: string; storageKey: string; sourceUrl: string | null };

let directory: string;
let publicDirectory: string;
let sourcePath: string;
let asset: Asset | null;

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function setupResolver() {
  const lookup = vi.fn(async (owner: string, exercise: string, source: string) =>
    owner === ownerId && exercise === exerciseId && source === sourceVideoId ? asset : null);
  return { lookup, resolve: createLocalVideoSourceBindingResolver(publicDirectory, lookup) };
}
const mismatch = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({
  name: "VideoGuidancePersistenceError", code: "SOURCE_MISMATCH",
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sachizu-local-source-binding-"));
  publicDirectory = join(directory, "public");
  await mkdir(join(publicDirectory, "uploads"), { recursive: true });
  sourcePath = join(publicDirectory, "uploads", "source.bin");
  await writeFile(sourcePath, originalBytes);
  asset = { id: sourceVideoId, storageKey: "uploads/source.bin", sourceUrl };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("Local video source binding without database or video analysis", () => {
  it("binds exact source bytes and owned metadata without rewriting the storage key", async () => {
    const { lookup, resolve } = setupResolver();
    expect(await resolve(ownerId, exerciseId, sourceVideoId)).toEqual({
      sourceVideoId, storageKey: "uploads/source.bin", sourceUrl, contentSha256: digest(originalBytes),
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(ownerId, exerciseId, sourceVideoId);
  });

  it("preserves a supported leading-slash storage key and a missing original URL", async () => {
    asset = { id: sourceVideoId, storageKey: "/uploads/source.bin", sourceUrl: null };
    expect(await setupResolver().resolve(ownerId, exerciseId, sourceVideoId)).toEqual({
      sourceVideoId, storageKey: "/uploads/source.bin", sourceUrl: null, contentSha256: digest(originalBytes),
    });
  });

  it.each([
    ["another-owner", exerciseId, sourceVideoId],
    [ownerId, "another-exercise", sourceVideoId],
    [ownerId, exerciseId, "another-source"],
  ])("keeps owner/exercise/source isolation for %s / %s / %s", async (owner, exercise, source) => {
    expect(await setupResolver().resolve(owner, exercise, source)).toBeNull();
  });

  it("returns no binding if lookup does not prove the exact requested source", async () => {
    const { resolve } = setupResolver();
    asset = null;
    expect(await resolve(ownerId, exerciseId, sourceVideoId)).toBeNull();
    asset = { id: "different-video", storageKey: "uploads/source.bin", sourceUrl };
    expect(await resolve(ownerId, exerciseId, sourceVideoId)).toBeNull();
  });

  it("recomputes content at submit time after same-length bytes change since page load", async () => {
    const { resolve } = setupResolver();
    const pageBinding = await resolve(ownerId, exerciseId, sourceVideoId);
    expect(changedBytes.byteLength).toBe(originalBytes.byteLength);
    await writeFile(sourcePath, changedBytes);
    const submitBinding = await resolve(ownerId, exerciseId, sourceVideoId);
    expect(pageBinding?.contentSha256).toBe(digest(originalBytes));
    expect(submitBinding?.contentSha256).toBe(digest(changedBytes));
    expect(submitBinding).not.toEqual(pageBinding);
  });

  it("detects an atomic source replacement between page load and submit", async () => {
    const { resolve } = setupResolver();
    const pageBinding = await resolve(ownerId, exerciseId, sourceVideoId);
    const replacement = join(publicDirectory, "uploads", "replacement.bin");
    await writeFile(replacement, changedBytes);
    await rename(replacement, sourcePath);
    const submitBinding = await resolve(ownerId, exerciseId, sourceVideoId);
    expect(submitBinding?.contentSha256).toBe(digest(changedBytes));
    expect(submitBinding).not.toEqual(pageBinding);
  });

  it("keeps source URL and storage-key changes in the binding even when bytes match", async () => {
    const { resolve } = setupResolver();
    const pageBinding = await resolve(ownerId, exerciseId, sourceVideoId);
    await writeFile(join(publicDirectory, "uploads", "moved.bin"), originalBytes);
    asset = { id: sourceVideoId, storageKey: "uploads/moved.bin", sourceUrl: "https://example.test/replaced-reference" };
    const submitBinding = await resolve(ownerId, exerciseId, sourceVideoId);
    expect(submitBinding?.contentSha256).toBe(pageBinding?.contentSha256);
    expect(submitBinding).toMatchObject({ storageKey: asset.storageKey, sourceUrl: asset.sourceUrl });
    expect(submitBinding).not.toEqual(pageBinding);
  });

  it("rejects traversal to an existing file outside the configured public root", async () => {
    await writeFile(join(directory, "outside.bin"), changedBytes);
    asset = { id: sourceVideoId, storageKey: "../outside.bin", sourceUrl };
    await mismatch(setupResolver().resolve(ownerId, exerciseId, sourceVideoId));
  });

  it("rejects a symlink under uploads that resolves outside the public root", async () => {
    const outside = join(directory, "outside.bin");
    await writeFile(outside, changedBytes);
    await symlink(outside, join(publicDirectory, "uploads", "escape.bin"));
    asset = { id: sourceVideoId, storageKey: "uploads/escape.bin", sourceUrl };
    await mismatch(setupResolver().resolve(ownerId, exerciseId, sourceVideoId));
  });

  it("rejects a nested directory symlink that escapes the public root", async () => {
    await mkdir(join(directory, "outside-directory"));
    await writeFile(join(directory, "outside-directory", "source.bin"), changedBytes);
    await symlink(join(directory, "outside-directory"), join(publicDirectory, "uploads", "escape-directory"));
    asset = { id: sourceVideoId, storageKey: "uploads/escape-directory/source.bin", sourceUrl };
    await mismatch(setupResolver().resolve(ownerId, exerciseId, sourceVideoId));
  });

  it("allows a symlink whose resolved target remains inside the public root", async () => {
    await symlink(sourcePath, join(publicDirectory, "uploads", "inside-link.bin"));
    asset = { id: sourceVideoId, storageKey: "uploads/inside-link.bin", sourceUrl };
    expect(await setupResolver().resolve(ownerId, exerciseId, sourceVideoId)).toEqual({
      sourceVideoId, storageKey: asset.storageKey, sourceUrl, contentSha256: digest(originalBytes),
    });
  });

  it.each(["uploads/missing.bin", "uploads", "."])("rejects missing or non-file storage key %s", async (storageKey) => {
    asset = { id: sourceVideoId, storageKey, sourceUrl };
    await mismatch(setupResolver().resolve(ownerId, exerciseId, sourceVideoId));
  });

  it("does not hide a failed ownership/source lookup as a successful or missing binding", async () => {
    const failure = new Error("offline lookup unavailable");
    const resolve = createLocalVideoSourceBindingResolver(publicDirectory, async () => { throw failure; });
    await expect(resolve(ownerId, exerciseId, sourceVideoId)).rejects.toBe(failure);
  });
});
