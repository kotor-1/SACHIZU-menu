/**
 * R10-B4A — 新規追加 picker 用の template 候補 provider（_running-template-options.ts）。
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import * as loader from "@/domain/running/rules/loader";
import { saveMenuRunningContext } from "@/infra/repositories/running-item-repository";
import { templatePickerForMenu, templatePickerForPlannedDate } from "@/actions/_running-template-options";
import { resetDb } from "../../helpers";
import { dtoRawKeyLeaks } from "../../presentation/running/helpers";

afterEach(() => vi.restoreAllMocks());
beforeEach(resetDb);

describe("R10-B4A: template picker provider", () => {
  it("plannedDate を基準に active RuleSet を選び、DTO だけを返す（RuleSet object を渡さない・内部キーを表示文字列に出さない）", () => {
    const active = vi.spyOn(loader, "getActiveRuleSet");
    const result = templatePickerForPlannedDate("2026-09-20");
    expect(active).toHaveBeenCalledTimes(1);
    expect(active).toHaveBeenCalledWith("2026-09-20");
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");

    const json = JSON.stringify(result.picker);
    for (const ruleSetKey of ["envelopes", "evidence", "eligibility", "constraints", "plausibility", "ruleSetVersion", "coachEditable"]) {
      expect(json, ruleSetKey).not.toContain(`"${ruleSetKey}"`);
    }
    expect(result.picker.groups).toHaveLength(10);
    expect(dtoRawKeyLeaks(result.picker)).toEqual([]);
  });

  it("一覧は候補であり適格性の保証ではない（全件 canAttemptSelection=true、候補の説明を持つ）", () => {
    const result = templatePickerForPlannedDate("2026-09-20");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.picker.groups.flatMap((g) => g.options).every((o) => o.canAttemptSelection)).toBe(true);
    expect(result.picker.candidateNote).toMatch(/候補/);
    expect(result.picker.candidateNote).toMatch(/追加するときに判定/);
  });

  it("plannedDate が無い・実在しない日付なら候補を出さない（当日で代用しない・RuleSet を選ばない）", () => {
    const active = vi.spyOn(loader, "getActiveRuleSet");
    for (const value of [null, "", "2026-02-30", "20260920"]) {
      expect(templatePickerForPlannedDate(value), String(value)).toMatchObject({ status: "UNAVAILABLE" });
    }
    expect(active).not.toHaveBeenCalled();
    const code = fs.readFileSync(path.join(process.cwd(), "src/actions/_running-template-options.ts"), "utf8");
    expect(code).not.toMatch(/new Date\(|Date\.now\(/);
  });

  it("active RuleSet を解決できなければ安全な日本語メッセージ（例外を client へ漏らさない）", () => {
    vi.spyOn(loader, "getActiveRuleSet").mockImplementation(() => {
      throw new Error("No ACTIVE or DRAFT RuleSet is available");
    });
    const result = templatePickerForPlannedDate("2026-09-20");
    expect(result).toEqual({ status: "UNAVAILABLE", message: "この計画日に使えるルールセットが見つからないため、練習の型の候補を表示できません。" });
  });

  it("メニューの RunningMenuContext.plannedDate を使う。context が無ければ候補を出さない", async () => {
    const menu = await prisma.menuTemplate.create({ data: { name: "走メニュー" } });
    expect(await templatePickerForMenu(menu.id)).toMatchObject({ status: "UNAVAILABLE" });
    expect(await templatePickerForMenu("missing")).toMatchObject({ status: "UNAVAILABLE", message: "メニューが見つかりません。" });

    await saveMenuRunningContext(
      menu.id,
      JSON.stringify({
        schemaVersion: 1,
        subject: { kind: "GROUP", label: "G", members: [], allowAdvancedMethods: false },
        plannedDate: "2026-10-01",
        plannedAt: null,
        availableMinutes: null,
      }),
    );
    const active = vi.spyOn(loader, "getActiveRuleSet");
    expect((await templatePickerForMenu(menu.id)).status).toBe("OK");
    expect(active).toHaveBeenCalledWith("2026-10-01");
  });
});
