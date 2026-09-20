import { describe, expect, it } from "vitest";
import { COMPETITION_PRIORITIES } from "@/domain/running/types/primitives";
import {
  COMPETITION_PRIORITY_LABEL_JA,
  COMPETITION_LOAD_CATEGORY_LABEL_JA,
  competitionLoadCategoriesLabel,
  competitionDateFromDb,
  formatCompetitionDateRange,
  presentCompetition,
  presentCompetitionSession,
} from "@/presentation/running/competition";
import { buildCompetitionPlanningSnapshot } from "@/domain/running/persistence/sessionSnapshot";

describe("R11-B5 competition presentation", () => {
  it("全priorityに日本語labelがある", () => {
    expect(Object.keys(COMPETITION_PRIORITY_LABEL_JA).sort()).toEqual([...COMPETITION_PRIORITIES].sort());
    for (const priority of COMPETITION_PRIORITIES) expect(COMPETITION_PRIORITY_LABEL_JA[priority]).not.toContain(priority);
  });

  it("単日・月跨ぎ・年跨ぎをdate-onlyで表示する", () => {
    expect(formatCompetitionDateRange("2026-10-03", null)).toBe("2026年10月3日");
    expect(formatCompetitionDateRange("2026-10-03", "2026-10-04")).toBe("2026年10月3日〜4日");
    expect(formatCompetitionDateRange("2026-10-31", "2026-11-01")).toBe("2026年10月31日〜11月1日");
    expect(formatCompetitionDateRange("2026-12-31", "2027-01-01")).toBe("2026年12月31日〜2027年1月1日");
  });

  it("UTC保存日をlocal timezoneに再解釈せず、日付がずれない", () => {
    expect(competitionDateFromDb(new Date("2026-10-03T00:00:00.000Z"))).toBe("2026-10-03");
  });

  it("owner/timestamp/raw Prisma objectをDTOに漏らさない", () => {
    const row = {
      id: "c1", ownerId: "default-coach", name: "県大会", date: new Date("2026-10-03T00:00:00.000Z"),
      endDate: null, priority: "IMPORTANT", note: "<script>alert(1)</script>", createdAt: new Date(), updatedAt: new Date(),
    };
    const dto = presentCompetition(row);
    expect(dto).toMatchObject({ id: "c1", priorityLabel: "重要大会", date: "2026-10-03" });
    expect(dto).not.toHaveProperty("ownerId");
    expect(dto).not.toHaveProperty("createdAt");
    expect(dto.note).toBe("<script>alert(1)</script>");
  });

  it("RACE/RELAY/mixedを日本語化し、raw enumを表示labelへ漏らさない", () => {
    expect(Object.keys(COMPETITION_LOAD_CATEGORY_LABEL_JA).sort()).toEqual(["RACE", "RELAY"]);
    expect(competitionLoadCategoriesLabel(["RACE"])).toBe("個人種目");
    expect(competitionLoadCategoriesLabel(["RELAY"])).toBe("リレー");
    expect(competitionLoadCategoriesLabel(["RACE", "RELAY"])).toBe("個人種目・リレー");
    for (const label of Object.values(COMPETITION_LOAD_CATEGORY_LABEL_JA)) expect(label).not.toMatch(/RACE|RELAY/);
  });

  it("Competition Sessionをsafe DTOへ変換し、snapshot corruptionはraw値を出さない", () => {
    const dto = presentCompetitionSession({
      id: "s1",
      date: new Date("2026-09-20T00:00:00.000Z"),
      status: "COMPLETED",
      planningSnapshotJson: JSON.stringify(buildCompetitionPlanningSnapshot("2026-09-20", ["RACE", "RELAY"])),
    });
    expect(dto).toMatchObject({ id: "s1", date: "2026-09-20", categories: ["RACE", "RELAY"], categoriesLabel: "個人種目・リレー" });
    expect(dto).not.toHaveProperty("planningSnapshotJson");
    const unreadable = presentCompetitionSession({ id: "s2", date: new Date("2026-09-20"), status: "COMPLETED", planningSnapshotJson: JSON.stringify({ schemaVersion: 1, competitionLoadCategories: [] }) });
    expect(unreadable).toMatchObject({ categories: null, categoriesLabel: "参加種別を確認できません" });
    expect(JSON.stringify(unreadable)).not.toContain("competitionLoadCategories");
  });
});
