/**
 * R11-B7A.2 — Session Action の error boundary。
 *
 * `createSessionAction` / `updateSessionAction` / `updateSessionItemAction` は、
 * 内部 service / repository が投げた未知の例外の message を Client へ返してはいけない。
 * 返してよいのは、明示的に safe と定義した typed error（`CompetitionSessionMutationError`）の
 * message と、固定の日本語文言だけ。
 *
 * ここでは `instanceof Error` であることだけを理由に `error.message` を許可していないことを、
 * 実 Action + 実 typed error で確認する（action を import する前に repository を spy する）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionRepository from "@/infra/repositories/session-repository";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const { createSessionAction, updateSessionAction, updateSessionItemAction } = await import(
  "@/actions/session-actions"
);
const { CompetitionSessionMutationError } = sessionRepository;

/** Prisma の実エラーに含まれ得る内部情報を模した sentinel。 */
const SENTINEL = "SECRET_INTERNAL_SENTINEL prisma://private/path";
const PRISMA_LIKE =
  "Invalid `prisma.trainingSession.create()` invocation in /Users/apple/private/repo/src/infra/repositories/session-repository.ts:132:36";

/** Client へ漏れてはいけない内部 detail。 */
const FORBIDDEN_TERMS = [
  "SECRET_INTERNAL_SENTINEL",
  "prisma://private/path",
  "Prisma",
  "Invalid `prisma",
  "invocation in",
  "/Users/",
  "repository.ts",
  "SQL",
  "stack",
  "node_modules",
];

const SAFE_CREATE = "セッションを作成できませんでした。もう一度お試しください。";
const SAFE_UPDATE = "セッションを更新できませんでした。もう一度お試しください。";
const SAFE_ITEM = "項目を更新できませんでした。もう一度お試しください。";

function sessionForm(overrides: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("title", "境界テスト");
  f.set("date", "2026-09-20");
  f.set("groupName", "");
  f.set("location", "");
  f.set("weather", "");
  f.set("condition", "");
  f.set("status", "PLANNED");
  f.set("coachNote", "");
  for (const [k, v] of Object.entries(overrides)) f.set(k, v);
  return f;
}

function itemForm(): FormData {
  const f = new FormData();
  f.set("done", "");
  f.append("done", "true");
  f.set("actualSets", "");
  f.set("actualReps", "");
  f.set("actualDistanceMeters", "");
  f.set("actualDurationSeconds", "");
  f.set("actualLoadKg", "");
  f.set("actualNote", "");
  return f;
}

function leakedTerms(payload: unknown): string[] {
  const serialized = JSON.stringify(payload);
  return FORBIDDEN_TERMS.filter((term) => serialized.includes(term));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("R11-B7A.2 Session Action error boundary", () => {
  it("createSessionAction は未知の例外 message を Client へ返さない", async () => {
    vi.spyOn(sessionRepository, "createSession").mockRejectedValue(new Error(SENTINEL));

    const result = await createSessionAction(null, sessionForm());

    expect(leakedTerms(result)).toEqual([]);
    expect(result).toEqual({ ok: false, message: SAFE_CREATE });
  });

  it("createSessionAction は Prisma 風の内部情報も返さない", async () => {
    vi.spyOn(sessionRepository, "createSession").mockRejectedValue(new Error(PRISMA_LIKE));

    const result = await createSessionAction(null, sessionForm());

    expect(leakedTerms(result)).toEqual([]);
    expect(result).toEqual({ ok: false, message: SAFE_CREATE });
  });

  it("updateSessionAction は未知の例外 message を Client へ返さない", async () => {
    vi.spyOn(sessionRepository, "updateSession").mockRejectedValue(new Error(SENTINEL));

    const result = await updateSessionAction("session-1", null, sessionForm());

    expect(leakedTerms(result)).toEqual([]);
    expect(result).toEqual({ ok: false, message: SAFE_UPDATE });
  });

  it("updateSessionAction は Prisma 風の内部情報も返さない", async () => {
    vi.spyOn(sessionRepository, "updateSession").mockRejectedValue(new Error(PRISMA_LIKE));

    const result = await updateSessionAction("session-1", null, sessionForm());

    expect(leakedTerms(result)).toEqual([]);
    expect(result).toEqual({ ok: false, message: SAFE_UPDATE });
  });

  it("updateSessionItemAction は未知の例外 message を Client へ返さない", async () => {
    vi.spyOn(sessionRepository, "updateSessionItemResult").mockRejectedValue(new Error(SENTINEL));

    const result = await updateSessionItemAction("session-1", "item-1", null, itemForm());

    expect(leakedTerms(result)).toEqual([]);
    expect(result).toEqual({ ok: false, message: SAFE_ITEM });
  });

  it("updateSessionItemAction は Prisma 風の内部情報も返さない", async () => {
    vi.spyOn(sessionRepository, "updateSessionItemResult").mockRejectedValue(new Error(PRISMA_LIKE));

    const result = await updateSessionItemAction("session-1", "item-1", null, itemForm());

    expect(leakedTerms(result)).toEqual([]);
    expect(result).toEqual({ ok: false, message: SAFE_ITEM });
  });

  it("明示的に safe な typed error の mapping は維持する", async () => {
    vi.spyOn(sessionRepository, "updateSession").mockRejectedValue(new CompetitionSessionMutationError());
    vi.spyOn(sessionRepository, "updateSessionItemResult").mockRejectedValue(new CompetitionSessionMutationError());

    expect(await updateSessionAction("session-1", null, sessionForm())).toEqual({
      ok: false,
      message: "大会実績は通常の練習編集では変更できません",
    });
    expect(await updateSessionItemAction("session-1", "item-1", null, itemForm())).toEqual({
      ok: false,
      message: "大会実績は通常の練習編集では変更できません",
    });
  });

  it("Error でない値が throw されても固定文言へ落とす", async () => {
    vi.spyOn(sessionRepository, "createSession").mockRejectedValue(SENTINEL);

    const result = await createSessionAction(null, sessionForm());

    expect(leakedTerms(result)).toEqual([]);
    expect(result).toEqual({ ok: false, message: SAFE_CREATE });
  });

  it("正常系の create / update / item update は既存挙動を維持する", async () => {
    vi.spyOn(sessionRepository, "createSession").mockResolvedValue({ id: "session-1" } as never);
    vi.spyOn(sessionRepository, "updateSession").mockResolvedValue(undefined as never);
    vi.spyOn(sessionRepository, "updateSessionItemResult").mockResolvedValue(undefined as never);

    // create は成功後に詳細へ redirect する（Next.js では redirect が throw する）
    await expect(createSessionAction(null, sessionForm())).rejects.toThrow(/^NEXT_REDIRECT:\/sessions\/session-1$/);
    expect(await updateSessionAction("session-1", null, sessionForm())).toEqual({
      ok: true,
      data: { id: "session-1" },
      message: "保存しました",
    });
    expect(await updateSessionItemAction("session-1", "item-1", null, itemForm())).toEqual({
      ok: true,
      data: null,
      message: "記録しました",
    });
  });

  it("入力 validation の safe message は従来どおり", async () => {
    const invalid = sessionForm({ title: "" });

    expect(await createSessionAction(null, invalid)).toMatchObject({
      ok: false,
      message: "入力内容を確認してください",
    });
  });
});
