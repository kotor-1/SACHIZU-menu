/**
 * R10-B4B — メニューの対象グループ・計画日（RunningMenuContext）の入力モデル。
 *
 * 「今日で補わない」「勝手に直さない」「健康情報を持たない」を、入力側の純粋関数で固定する。
 */
import { describe, expect, it } from "vitest";
import { runningMenuContextSchema } from "@/domain/running/persistence/menuContext";
import {
  buildRunningContextJson,
  contextDraftFrom,
  emptyContextDraft,
  emptyMemberDraft,
  isoDateTimeFromLocal,
  type RunningContextDraft,
} from "@/presentation/running/menu-context";

function draft(overrides: Partial<RunningContextDraft> = {}): RunningContextDraft {
  return {
    ...emptyContextDraft(),
    label: "短距離ブロック",
    plannedDate: "2026-09-20",
    members: [{ ...emptyMemberDraft(), ageBandOverride: "U18", maturityStatus: "POST", maturityConfidence: "HIGH", maturityMethod: "COACH_OBSERVATION", primaryEvent: "400m" }],
    ...overrides,
  };
}

describe("R10-B4B: 計画日", () => {
  it("未入力なら保存させない（今日の日付で補わない）", () => {
    const built = buildRunningContextJson(draft({ plannedDate: "" }));
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.message).toContain("今日の日付では補いません");
    // 今日の日付が混入していないこと
    expect(JSON.stringify(built)).not.toContain(new Date().toISOString().slice(0, 10));
  });

  it("開始予定時刻だけの入力は、計画日を求める", () => {
    const built = buildRunningContextJson(draft({ plannedDate: "", plannedAtLocal: "2026-09-20T16:00", plannedAtOffsetMinutes: -540 }));
    expect(built).toEqual({ ok: false, message: "開始予定時刻だけでは保存できません。先に計画日を入力してください。" });
  });

  it("空の設定は計画日も対象グループ名も持たない（保存が無ければ入力欄は空のまま）", () => {
    expect(contextDraftFrom(null)).toEqual(emptyContextDraft());
    expect(emptyContextDraft().plannedDate).toBe("");
    expect(emptyContextDraft().plannedAtLocal).toBe("");
  });
});

describe("R10-B4B: 開始予定時刻", () => {
  it("端末の offset を明示的に付ける（この層で現在時刻・既定のタイムゾーンを推測しない）", () => {
    expect(isoDateTimeFromLocal("2026-09-20T16:00", -540)).toBe("2026-09-20T16:00:00+09:00");
    expect(isoDateTimeFromLocal("2026-09-20T16:00", 0)).toBe("2026-09-20T16:00:00+00:00");
    expect(isoDateTimeFromLocal("2026-09-20T16:00", 300)).toBe("2026-09-20T16:00:00-05:00");
    expect(isoDateTimeFromLocal("2026-09-20", -540)).toBeNull();
    expect(isoDateTimeFromLocal("2026-09-20T16:00", Number.NaN)).toBeNull();
  });

  it("暦日が計画日と違えば、どちらも自動で直さずエラーにする", () => {
    const built = buildRunningContextJson(draft({ plannedAtLocal: "2026-09-21T06:00", plannedAtOffsetMinutes: -540 }));
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.message).toContain("自動では合わせません");
  });

  it("offset を読めないときは保存しない（+09:00 などを勝手に決めない）", () => {
    expect(buildRunningContextJson(draft({ plannedAtLocal: "2026-09-20T16:00", plannedAtOffsetMinutes: null }))).toEqual({
      ok: false,
      message: "開始予定時刻を読み取れませんでした。入力し直してください。",
    });
  });
});

describe("R10-B4B: 保存する値", () => {
  it("domain schema（.strict()）そのままの形になり、健康情報・生年月日のキーを持たない", () => {
    const built = buildRunningContextJson(
      draft({
        plannedAtLocal: "2026-09-20T16:00",
        plannedAtOffsetMinutes: -540,
        availableMinutes: "90",
        memberCountHint: "8",
        allowAdvancedMethods: true,
      }),
    );
    expect(built.ok, JSON.stringify(built)).toBe(true);
    if (!built.ok) throw new Error("unreachable");

    expect(runningMenuContextSchema.safeParse(JSON.parse(built.json)).success).toBe(true);
    expect(built.value).toEqual({
      schemaVersion: 1,
      subject: {
        kind: "GROUP",
        label: "短距離ブロック",
        members: [
          {
            ageBandOverride: "U18",
            maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: null },
            trainingAge: { structuredSprintYears: null, coachAssignedTier: null },
            primaryEvent: "400m",
          },
        ],
        memberCountHint: 8,
        allowAdvancedMethods: true,
      },
      plannedDate: "2026-09-20",
      plannedAt: "2026-09-20T16:00:00+09:00",
      availableMinutes: 90,
    });
    for (const key of ["birthDate", "sexForNorms", "pain", "soreness", "sleep", "fatigue", "readiness", "medical"]) {
      expect(built.json).not.toContain(key);
    }
  });

  it("未入力は 0 にしない（練習時間・練習年数は null のまま）", () => {
    const built = buildRunningContextJson(draft({ availableMinutes: "", members: [emptyMemberDraft()] }));
    if (!built.ok) throw new Error(built.message);
    expect(built.value.availableMinutes).toBeNull();
    expect(built.value.subject.members[0]!.trainingAge.structuredSprintYears).toBeNull();
    expect(built.value.subject.members[0]).not.toHaveProperty("ageBandOverride");
    expect(built.value.subject).not.toHaveProperty("memberCountHint");
  });

  it("数値の入力エラーは、何行目かが分かる日本語で返す", () => {
    expect(buildRunningContextJson(draft({ availableMinutes: "0" })).ok).toBe(false);
    expect(buildRunningContextJson(draft({ memberCountHint: "1.5" })).ok).toBe(false);
    const years = buildRunningContextJson(draft({ members: [emptyMemberDraft(), { ...emptyMemberDraft(), structuredSprintYears: "-1" }] }));
    expect(years.ok).toBe(false);
    if (years.ok) throw new Error("unreachable");
    expect(years.message).toContain("2人目");
  });

  it("対象グループ名は必須", () => {
    expect(buildRunningContextJson(draft({ label: "   " })).ok).toBe(false);
  });

  it("保存済みの設定を入力欄へ戻すと、同じ値で保存し直せる（往復しても値が変わらない）", () => {
    const first = buildRunningContextJson(
      draft({ plannedAtLocal: "2026-09-20T16:00", plannedAtOffsetMinutes: -540, availableMinutes: "90", memberCountHint: "8" }),
    );
    if (!first.ok) throw new Error(first.message);
    const again = buildRunningContextJson(contextDraftFrom(first.value));
    if (!again.ok) throw new Error(again.message);
    expect(again.value).toEqual(first.value);
  });
});
