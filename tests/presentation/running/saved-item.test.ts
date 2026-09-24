/**
 * R10-B3 — 保存済み RUNNING_V2 MenuItem の表示（server presentation service）。
 *
 * - 題名は plan 時点の snapshot（TEMPLATE_SELECTED.params.templateLabelJa）が primary source
 * - 理由本文は保存済み MenuItem.rationale（再レンダリングしない）
 * - Evidence の出典種類は保存時の version + contentHash と完全一致した RuleSet だけから引く
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as renderJa from "@/domain/running/rationale/render-ja";
import * as loader from "@/domain/running/rules/loader";
import type { RuleSetIdentityResult } from "@/domain/running/rules/loader";
import type { RuleSet } from "@/domain/running/rules/schema";
import type { Provenance } from "@/domain/running/persistence/provenance";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import { isoDateTimeSchema } from "@/domain/running/types/primitives";
import { ProvenancePanel } from "@/components/running/provenance-panel";
import { presentRunningItem } from "@/presentation/running/item";
import { buildFieldEditRequest } from "@/presentation/running/editor-requests";
import { presentSavedRunningMenuItem, type RuleSetIdentityResolver, type SavedRunningMenuItemRow } from "@/presentation/running/server";
import { planAcc, planEa, planMvFly20, planWith, provenanceFor, athlete, FLY20_PHOTO } from "../../repository/running/fixtures";
import { productionRuleSet, rawKeyLeaks, renderMarkup, stripTags } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const HASH_A = "hash-rs-test-a";
const HASH_B = "hash-rs-test-b";

/** 本番 RuleSet を複製して別の版を作る（production JSON は変更しない）。 */
function ruleSetVariant(version: string, edit: (rs: RuleSet) => void): RuleSet {
  const rs = structuredClone(productionRuleSet());
  rs.ruleSetVersion = version;
  edit(rs);
  return rs;
}

const MV_EVIDENCE_ID = () => {
  const p = planMvFly20();
  return p.rep.kind === "FLY" ? p.rep.flyZoneDistanceM.evidenceIds[0]! : "";
};

function setup() {
  const evidenceId = MV_EVIDENCE_ID();
  // A: 保存時の版。フライ20m の出典は「メタ分析」にしておく。
  const ruleSetA = ruleSetVariant("rs-test-A", (rs) => {
    rs.templates.find((t) => t.id === "MV_FLY20")!.labelJa = "フライ20m";
    rs.evidence = rs.evidence.map((e) => (e.id === evidenceId ? { ...e, sourceType: "META_ANALYSIS", evidenceLevel: 1 } : e));
  });
  // B: 後から active になった版。template 名も出典の種類も変わっている。
  const ruleSetB = ruleSetVariant("rs-test-B", (rs) => {
    rs.status = "ACTIVE";
    rs.templates.find((t) => t.id === "MV_FLY20")!.labelJa = "フライ20m（改訂版の名称）";
    rs.evidence = rs.evidence.map((e) => (e.id === evidenceId ? { ...e, sourceType: "EXPERT_OPINION", evidenceLevel: 5 } : e));
  });

  const prescription = planWith({ ruleSet: ruleSetA, contentHash: HASH_A, isDraftFallback: false }, "MAX_VELOCITY", "MV_FLY20", {
    subject: athlete({ marks: [FLY20_PHOTO] }),
  });
  const resolver: RuleSetIdentityResolver = ({ version, contentHash }): RuleSetIdentityResult => {
    if (version === "rs-test-A") return contentHash === HASH_A ? { status: "OK", ruleSet: ruleSetA, contentHash } : { status: "REJECTED", issue: "RULESET_IDENTITY_MISMATCH" };
    if (version === "rs-test-B") return contentHash === HASH_B ? { status: "OK", ruleSet: ruleSetB, contentHash } : { status: "REJECTED", issue: "RULESET_IDENTITY_MISMATCH" };
    return { status: "REJECTED", issue: "VERSION_NOT_FOUND" };
  };
  const savedRationale = renderJa.renderRationaleJa(prescription.rationale).join("\n");
  const row: SavedRunningMenuItemRow = {
    id: "item-mv-1",
    displayName: "フライ20m（助走45m＋フライ20m・1セット×4本）",
    rationale: savedRationale,
    prescriptionKind: "RUNNING_V2",
    prescriptionJson: JSON.stringify(prescription),
    provenanceJson: JSON.stringify(provenanceFor(prescription)),
    ruleSetVersion: "rs-test-A",
    ruleSetContentHash: HASH_A,
  };
  return { ruleSetA, ruleSetB, prescription, resolver, row, savedRationale };
}

function okItem(result: ReturnType<typeof presentSavedRunningMenuItem>) {
  if (result.status !== "OK") throw new Error(`expected OK, got ${result.status}`);
  return result.item;
}

describe("R10-B3: 保存済み item の題名（template label source）", () => {
  it("TEMPLATE_SELECTED.params.templateLabelJa を題名にする。exact / active RuleSet の label が変わっても題名は変わらない", () => {
    const { resolver, row, ruleSetA } = setup();
    // 保存後に exact 版側の表示名を書き換えても（= current label が将来変わっても）snapshot が優先される
    ruleSetA.templates.find((t) => t.id === "MV_FLY20")!.labelJa = "フライ20m（書き換え後）";
    const item = okItem(presentSavedRunningMenuItem(row, { resolveRuleSetByIdentity: resolver }));
    expect(item.title).toBe("フライ20m");
    expect(item.title).not.toMatch(/改訂版|書き換え後/);
    // Method 名は主見出しにしない（副題の分類名だけ）
    expect(item.subtitle).toBe("最高速度");
  });

  it("snapshot が無ければ displayName → exact RuleSet の label → 汎用名の順（理由文を解析しない）", () => {
    const { prescription, ruleSetA } = setup();
    const withoutSnapshot = structuredClone(prescription) as RunningPrescriptionValue;
    withoutSnapshot.rationale = withoutSnapshot.rationale.filter((l) => l.code !== "TEMPLATE_SELECTED");
    const base = { id: "i", rationale: "保存された理由文「フライ30m」", prescription: withoutSnapshot, provenance: null };

    expect(presentRunningItem({ ...base, displayName: "保存時の表示名", exactRuleSet: { status: "OK", ruleSet: ruleSetA } }).title).toBe("保存時の表示名");
    expect(presentRunningItem({ ...base, displayName: null, exactRuleSet: { status: "OK", ruleSet: ruleSetA } }).title).toBe("フライ20m");
    expect(presentRunningItem({ ...base, displayName: null, exactRuleSet: { status: "UNAVAILABLE" } }).title).toBe("走トレーニング");
  });
});

describe("G.6: 保存済み coach-entered approach distance", () => {
  it("実在する coach-entered 助走距離だけ直接編集可能にし、Envelope 範囲や override を作らない", () => {
    const prescription = structuredClone(planEa());
    if (prescription.rep.kind !== "ATTEMPTS") throw new Error("expected ATTEMPTS");
    prescription.rep.approachDistanceM = { value: 30, unit: "m", source: "COACH_ENTERED" };
    const item = presentRunningItem({
      id: "ea-saved",
      displayName: null,
      rationale: "保存済み",
      prescription,
      provenance: null,
      exactRuleSet: { status: "OK", ruleSet: productionRuleSet() },
    });
    const approach = item.editor.fields.find((field) => field.keyInternal === "approachDistanceM")!;
    expect(approach).toMatchObject({
      currentValue: 30,
      originLabel: "コーチ入力",
      editable: true,
      readOnly: false,
      recommended: null,
      coachEditable: null,
      hardSafety: null,
      overrideLayers: [],
    });
    expect(buildFieldEditRequest(item.id, approach, "35")).toMatchObject({
      ok: true,
      request: { itemId: "ea-saved", field: "approachDistanceM", value: 35, displayedFromValue: 30 },
    });
  });
});

describe("R10-B3: 保存済み rationale を再レンダリングしない", () => {
  it("レンダラの文言を変えても、MenuItem.rationale の保存文字列をそのまま表示する", () => {
    const { resolver, row, savedRationale } = setup();
    const spy = vi.spyOn(renderJa, "renderRationaleJa").mockReturnValue(["（レンダラ側で変更された新しい文言）"]);
    const item = okItem(presentSavedRunningMenuItem(row, { resolveRuleSetByIdentity: resolver }));
    expect(item.rationaleText).toBe(savedRationale);
    expect(item.rationaleText).not.toMatch(/新しい文言/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rationale が空でも構造化 RationaleLine から作り直さない", () => {
    const { resolver, row } = setup();
    const item = okItem(presentSavedRunningMenuItem({ ...row, rationale: null }, { resolveRuleSetByIdentity: resolver }));
    expect(item.rationaleText).toBe("保存された処方の根拠の文章がありません。");
  });
});

describe("R10-B3: Evidence は exact RuleSet だけから表示する", () => {
  it("保存時の RuleSet A の出典種類を表示する（active B が別の出典でも B を使わない・active selector を呼ばない）", () => {
    const { resolver, row } = setup();
    const active = vi.spyOn(loader, "getActiveRuleSet");
    const item = okItem(presentSavedRunningMenuItem(row, { resolveRuleSetByIdentity: resolver }));
    if (item.provenance.status !== "AVAILABLE" || item.provenance.evidence.status !== "AVAILABLE") throw new Error("unreachable");
    const labels = item.provenance.evidence.sourceTypes.map((t) => t.label);
    expect(labels).toContain("メタ分析");
    expect(labels).not.toContain("専門家意見");
    expect(active).not.toHaveBeenCalled();
  });

  it("hash 不一致なら B へ fallback せず「根拠の詳細を確認できません」。処方と理由文の表示は続ける", () => {
    const { resolver, row, savedRationale } = setup();
    const item = okItem(presentSavedRunningMenuItem({ ...row, ruleSetContentHash: "hash-tampered" }, { resolveRuleSetByIdentity: resolver }));
    if (item.provenance.status !== "AVAILABLE") throw new Error("unreachable");
    expect(item.provenance.evidence).toEqual({ status: "UNAVAILABLE", message: "根拠の詳細を確認できません。" });
    expect(item.rationaleText).toBe(savedRationale);
    expect(item.dose.countsLabel).toMatch(/本/);
    // exact 版が無いので編集・再計算の前提も満たさない（Action 側の最終判定とは別の表示上の目安）
    expect(item.canEdit).toBe(false);
    expect(item.editUnavailableMessage).toMatch(/版を確認できない/);
    const text = stripTags(renderMarkup(ProvenancePanel, { provenance: item.provenance }));
    expect(text).toMatch(/根拠の詳細を確認できません/);
    expect(text).not.toMatch(/専門家意見|メタ分析/);
  });

  it("旧版ファイルが存在しない（VERSION_NOT_FOUND）場合も current で代用しない", () => {
    const { row } = setup();
    // 既定の resolver は本番 loader の getRuleSetByIdentity（rs-test-A は存在しない）
    const item = okItem(presentSavedRunningMenuItem(row));
    if (item.provenance.status !== "AVAILABLE") throw new Error("unreachable");
    expect(item.provenance.evidence.status).toBe("UNAVAILABLE");
    // aggregate 型の field は exact Envelope が無いので出さない（範囲を current から推測しない）
    expect(item.editor.fields.map((f) => f.keyInternal)).not.toContain("totalReps");
  });

  it("本番 RuleSet で保存した item は、既定の exact identity loader で出典種類を表示できる", () => {
    const p = planAcc();
    const item = okItem(
      presentSavedRunningMenuItem({
        id: "acc",
        displayName: null,
        rationale: "保存済み",
        prescriptionKind: "RUNNING_V2",
        prescriptionJson: JSON.stringify(p),
        provenanceJson: JSON.stringify(provenanceFor(p)),
        ruleSetVersion: p.ruleSet.version,
        ruleSetContentHash: p.ruleSet.contentHash,
      }),
    );
    if (item.provenance.status !== "AVAILABLE") throw new Error("unreachable");
    expect(item.provenance.evidence.status).toBe("AVAILABLE");
    expect(item.canEdit).toBe(true);
  });

  it("MenuItem 列と処方 JSON / provenance の版が食い違う場合も exact とみなさない（fail closed）", () => {
    const { resolver, row, prescription } = setup();
    const otherProvenance: Provenance = { ...provenanceFor(prescription), ruleSet: { version: "rs-test-B", contentHash: HASH_B, status: "ACTIVE" } };
    const item = okItem(presentSavedRunningMenuItem({ ...row, provenanceJson: JSON.stringify(otherProvenance) }, { resolveRuleSetByIdentity: resolver }));
    if (item.provenance.status !== "AVAILABLE") throw new Error("unreachable");
    expect(item.provenance.evidence.status).toBe("UNAVAILABLE");
  });
});

describe("R10-B3: Provenance の表示（AI とエンジンの区別・技術情報を出さない）", () => {
  it("エンジン作成: 「エンジンで作成」。contentHash / engineVersion / evidenceId を描画しない", () => {
    const { resolver, row, prescription } = setup();
    const item = okItem(presentSavedRunningMenuItem(row, { resolveRuleSetByIdentity: resolver }));
    if (item.provenance.status !== "AVAILABLE") throw new Error("unreachable");
    expect(item.provenance.generatedByLabel).toBe("エンジンで作成");
    expect(item.provenance.aiProposal).toBeNull();
    const markup = renderMarkup(ProvenancePanel, { provenance: item.provenance });
    expect(markup).not.toContain(HASH_A);
    expect(markup).not.toContain("0.1.0+test");
    for (const id of provenanceFor(prescription).evidenceIds) expect(markup).not.toContain(id);
    expect(rawKeyLeaks(markup)).toEqual([]);
    expect(stripTags(markup)).toMatch(/rs-test-A（暫定版）/);
  });

  it("AI の提案: 「AIの提案」と提案理由を、エンジンの処方根拠とは別の枠で表示する。requestId は出さない", () => {
    const { resolver, row, prescription } = setup();
    const aiProvenance: Provenance = {
      ...provenanceFor(prescription),
      generatedBy: {
        proposer: { kind: "AI_PLANNER", provider: "provider-x", model: "model-y", requestId: "req-secret-123" },
        createdByCoach: false,
        acceptedByCoachAt: "2026-09-15T09:00:00+09:00" as Provenance["generatedBy"]["acceptedByCoachAt"],
      },
      aiReason: "前回より本数を控えめにした提案です",
    };
    const item = okItem(presentSavedRunningMenuItem({ ...row, provenanceJson: JSON.stringify(aiProvenance) }, { resolveRuleSetByIdentity: resolver }));
    if (item.provenance.status !== "AVAILABLE") throw new Error("unreachable");
    expect(item.provenance.generatedByLabel).toBe("AIの提案");
    expect(item.provenance.acceptanceLabel).toBe("コーチ承認済み（2026/9/15）");
    expect(item.provenance.aiProposal?.reason).toBe("前回より本数を控えめにした提案です");
    // エンジンの理由文（保存済み rationale）に AI の説明は混ざらない
    expect(item.rationaleText).not.toMatch(/控えめにした提案/);

    const markup = renderMarkup(ProvenancePanel, { provenance: item.provenance });
    const text = stripTags(markup);
    expect(text).toMatch(/AIの提案理由/);
    expect(text).toMatch(/数値と処方の根拠はエンジンが決めています/);
    expect(markup).not.toContain("req-secret-123");
    expect(rawKeyLeaks(markup)).toEqual([]);
  });

  it("override / coach edit の有無と理由を表示する", () => {
    const { resolver, row, prescription } = setup();
    const withChanges: Provenance = {
      ...provenanceFor(prescription),
      coachEdits: [{ at: "2026-09-15T09:00:00+09:00", field: "repRestS", from: 690, to: 720 }] as Provenance["coachEdits"],
      overrides: [
        { at: "2026-09-15T09:05:00+09:00", target: { kind: "FIELD", field: "buildUpM", layer: "COACH_EDITABLE" }, to: 75, reason: "助走を長く取りたい選手のため" },
      ] as Provenance["overrides"],
    };
    const item = okItem(presentSavedRunningMenuItem({ ...row, provenanceJson: JSON.stringify(withChanges) }, { resolveRuleSetByIdentity: resolver }));
    if (item.provenance.status !== "AVAILABLE") throw new Error("unreachable");
    expect(item.provenance.coachEdits.summaryLabel).toBe("あり（1件）");
    expect(item.provenance.coachEdits.items[0]).toMatchObject({ label: "本間レスト", detail: "11分30秒 → 12分" });
    expect(item.provenance.overrides.items[0]).toMatchObject({ label: "助走（加速）区間（コーチ調整可能範囲の外）", detail: "設定値 75m", reason: "助走を長く取りたい選手のため" });
    expect(rawKeyLeaks(renderMarkup(ProvenancePanel, { provenance: item.provenance }))).toEqual([]);
  });

  it("初回 coach numeric input を変更前の値を作らず表示する", () => {
    const { resolver, row, prescription } = setup();
    const withInitialInput: Provenance = {
      ...provenanceFor(prescription),
      coachEdits: [{ at: isoDateTimeSchema.parse("2026-09-15T09:00:00+09:00"), field: "totalReps", to: 3 }],
    };
    const item = okItem(presentSavedRunningMenuItem({ ...row, provenanceJson: JSON.stringify(withInitialInput) }, { resolveRuleSetByIdentity: resolver }));
    if (item.provenance.status !== "AVAILABLE") throw new Error("unreachable");
    expect(item.provenance.coachEdits.items[0]).toMatchObject({ label: "総本数", detail: "初回入力: 3本" });
  });

  it("同値の coach edit は数値変更ではなくコーチ指定として表示する", () => {
    const { resolver, row, prescription } = setup();
    const withAdoption: Provenance = {
      ...provenanceFor(prescription),
      coachEdits: [{ at: isoDateTimeSchema.parse("2026-09-15T09:00:00+09:00"), field: "repRestS", from: 150, to: 150 }],
    };
    const item = okItem(presentSavedRunningMenuItem({ ...row, provenanceJson: JSON.stringify(withAdoption) }, { resolveRuleSetByIdentity: resolver }));
    if (item.provenance.status !== "AVAILABLE") throw new Error("unreachable");
    expect(item.provenance.coachEdits.items[0]).toMatchObject({ label: "本間レスト", detail: "コーチ指定: 2分30秒" });
  });

  it("provenance JSON が壊れていても処方は表示し、作成経緯だけ「確認できません」", () => {
    const { resolver, row } = setup();
    const item = okItem(presentSavedRunningMenuItem({ ...row, provenanceJson: "{broken" }, { resolveRuleSetByIdentity: resolver }));
    expect(item.provenance).toEqual({ status: "UNAVAILABLE", message: "作成経緯を確認できません。" });
    expect(item.title).toBe("フライ20m");
  });

  it("処方 JSON が壊れていれば UNREADABLE（数値を出さない）。LEGACY 行は対象外", () => {
    const { resolver, row } = setup();
    const broken = presentSavedRunningMenuItem({ ...row, prescriptionJson: "{}" }, { resolveRuleSetByIdentity: resolver });
    expect(broken).toMatchObject({ status: "UNREADABLE", title: row.displayName });
    expect(presentSavedRunningMenuItem({ ...row, prescriptionKind: "LEGACY" })).toEqual({ status: "NOT_RUNNING_V2", id: row.id });
  });
});
