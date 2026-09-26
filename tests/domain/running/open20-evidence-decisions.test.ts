/**
 * [OPEN20 一次資料照合の Human Decision 反映] を検証する。
 *
 * - OPEN-02: `vmaxEstimationModels = []`（単一 PB→Vmax モデル不採用）。
 * - OPEN-07/08/23: ADV 値は BEST_PRACTICE_SYNTHESIS（Haugen 2019 の evidence が PRIMARY_CHECKED）、
 *   DEV 値は ENGINE_POLICY のまま（昇格しない）。
 * - OPEN-12: VITTORI_SE の intensityPercent は EVIDENCE_INFORMED（SOURCE_BACKED + Vittori）。
 *   内部キー TEMPO_INTENSIVE は不変、表示ラベルだけ Special Endurance に変更。
 * - OPEN-14: UKA の source gap が evidence metadata に明示される。
 * 数値そのものは変更しない（NUMERIC_CHANGE_REQUIRED = NO）。
 */
import { describe, expect, it } from "vitest";
import { getRuleSet } from "@/domain/running/rules/loader";
import type { RuleSet } from "@/domain/running/rules/schema";
import { RUNNING_TRAINING_METHODS } from "@/domain/running/types/method";
import { METHOD_LABEL_JA } from "@/presentation/running/labels";

const rs = getRuleSet("rs-2026.09.0")!;

function envelope(rs: RuleSet, method: string, tier: string, templateId: string) {
  const env = rs.envelopes.find((e) => e.method === method && e.tier === tier && e.templateIds.includes(templateId));
  if (!env) throw new Error(`envelope not found: ${method}/${tier}/${templateId}`);
  return env;
}

describe("OPEN20 evidence decisions の反映", () => {
  it("OPEN-02: vmaxEstimationModels は空（単一 PB→Vmax モデル不採用）", () => {
    expect(rs.vmaxEstimationModels).toEqual([]);
  });

  it("OPEN-07: ACC session volume は ADV=SOURCE_BACKED（Haugen）、DEV=ENGINE_POLICY を維持", () => {
    const adv = envelope(rs, "ACCELERATION", "ADVANCED", "ACC_BLOCK_10").fields.sessionVolumeM!;
    const dev = envelope(rs, "ACCELERATION", "DEVELOPMENTAL", "ACC_BLOCK_10").fields.sessionVolumeM!;
    expect(adv.judgement).toBe("SOURCE_BACKED");
    expect(adv.recommended).toMatchObject({ min: 100, max: 300, unit: "m" });
    expect(dev.judgement).toBe("ENGINE_POLICY");
    expect(dev.recommended).toMatchObject({ min: 60, max: 160, unit: "m" });
  });

  it("OPEN-08: MV fly volume は ADV=SOURCE_BACKED、DEV=ENGINE_POLICY（数値不変）", () => {
    const adv = envelope(rs, "MAX_VELOCITY", "ADVANCED", "MV_FLY10").fields.flyVolumeM!;
    const dev = envelope(rs, "MAX_VELOCITY", "DEVELOPMENTAL", "MV_FLY10").fields.flyVolumeM!;
    expect(adv.judgement).toBe("SOURCE_BACKED");
    expect(adv.recommended).toMatchObject({ min: 50, max: 150, unit: "m" });
    expect(dev.judgement).toBe("ENGINE_POLICY");
    expect(dev.recommended).toMatchObject({ min: 20, max: 40, unit: "m" });
  });

  it("OPEN-23: RS repDistanceM は ADV=SOURCE_BACKED（Haugen 10–30m）、DEV=ENGINE_POLICY", () => {
    const adv = envelope(rs, "RESISTED_SPRINT", "ADVANCED", "RS_SLED_LIGHT").fields.repDistanceM!;
    const dev = envelope(rs, "RESISTED_SPRINT", "DEVELOPMENTAL", "RS_SLED_LIGHT").fields.repDistanceM!;
    expect(adv.judgement).toBe("SOURCE_BACKED");
    expect(adv.evidenceIds).toContain("EV_HAUGEN_2019_VOLUME_TABLE");
    expect(adv.recommended).toMatchObject({ min: 10, max: 30, unit: "m" });
    expect(dev.judgement).toBe("ENGINE_POLICY");
    expect(dev.recommended).toMatchObject({ min: 10, max: 20, unit: "m" });
  });

  it("OPEN-12: VITTORI_SE intensityPercent は EVIDENCE_INFORMED（SOURCE_BACKED + Vittori）", () => {
    const cell = envelope(rs, "TEMPO_INTENSIVE", "ADVANCED", "TI_VITTORI_SE").fields.intensityPercent!;
    expect(cell.judgement).toBe("SOURCE_BACKED");
    expect(cell.evidenceIds).toContain("EV_VITTORI_1981_PRIMARY");
    expect(cell.recommended).toMatchObject({ min: 90, max: 95, unit: "percent" });
  });

  it("OPEN-12: TI_COACH_DEFINED 70–94% は ENGINE_POLICY のまま（昇格しない）", () => {
    const cell = envelope(rs, "TEMPO_INTENSIVE", "ADVANCED", "TI_COACH_DEFINED").fields.intensityPercent!;
    expect(cell.judgement).toBe("ENGINE_POLICY");
    expect(cell.coachEditable).toMatchObject({ min: 70, max: 94, unit: "percent" });
  });

  it("OPEN-12: 内部キー TEMPO_INTENSIVE は不変、表示ラベルは Special Endurance", () => {
    expect(RUNNING_TRAINING_METHODS).toContain("TEMPO_INTENSIVE");
    expect(METHOD_LABEL_JA.TEMPO_INTENSIVE).toBe("速度持久（Special Endurance）");
  });

  it("Haugen 2019 evidence は BEST_PRACTICE_SYNTHESIS（COACHING_BEST_PRACTICE。verification は昇格しない）", () => {
    const vol = rs.evidence.find((e) => e.id === "EV_HAUGEN_2019_VOLUME_TABLE")!;
    expect(vol.sourceType).toBe("COACHING_BEST_PRACTICE");
    expect(vol.verification).toBe("SECONDARY_REPORT_ONLY");
    expect(vol.reference.doi).toBe("10.1186/s40798-019-0221-0");
    expect(vol.applicabilityNotes).toContain("best-practice synthesis");
    expect(vol.applicabilityNotes).toContain("Acc 100–300m");
  });

  it("OPEN-14: UKA source gap が evidence metadata に明示される", () => {
    const uka = rs.evidence.find((e) => e.id === "EV_UKA_CLASSIFICATION")!;
    expect(uka.applicabilityNotes).toContain("KNOWN_PRIMARY_SOURCE_GAP");
    expect(uka.verification).toBe("SECONDARY_REPORT_ONLY");
  });

  it("DEV 値の ENGINE_POLICY が一次資料由来に昇格されていない", () => {
    const devCells = [
      envelope(rs, "ACCELERATION", "DEVELOPMENTAL", "ACC_BLOCK_10").fields.sessionVolumeM!,
      envelope(rs, "MAX_VELOCITY", "DEVELOPMENTAL", "MV_FLY10").fields.flyVolumeM!,
      envelope(rs, "RESISTED_SPRINT", "DEVELOPMENTAL", "RS_SLED_LIGHT").fields.repDistanceM!,
      envelope(rs, "EVENT_APPROACH_SPEED", "DEVELOPMENTAL", "EA_JUMP_FULL_APPROACH").fields.attempts!,
    ];
    for (const cell of devCells) expect(cell.judgement).toBe("ENGINE_POLICY");
  });
});
