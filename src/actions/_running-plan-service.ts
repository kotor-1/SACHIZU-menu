/**
 * Running Prescription Engine v2 — R10-B1 の application service。
 *
 * `running-actions.ts` から呼ばれる、"use server" を付けない通常の server module。
 * 責務（§26）:
 *   1. Menu / MenuItem / RunningMenuContext / Competition / load-history を repository から読む
 *   2. RunningMenuContext から Subject を再構築する
 *   3. 保存済み version + contentHash（edit/override）または plannedDate 基準の active 版
 *      （new plan / recalculate）で RuleSet を明示的に解決する（active selector による
 *      通常編集時の silent upgrade はしない）
 *   4. PlanRequest を組み立てて `planRunningPrescriptionWithRuleSet` を呼ぶ
 *   5. Provenance を組み立てる
 *   6. repository へ保存する
 *
 * domain（`src/domain/running/**`）は Prisma を import できないため、repository 呼び出しは
 * すべてここに置く（このファイル自身も Prisma を直接叩かない。repository を経由する）。
 * Action 自身は「検証 → この service → repository → revalidate」の薄さを保つ。
 *
 * 数値ポリシー（rest の式・年齢係数・Method 総量定数・強度閾値等）はここに複製しない。
 * すべて domain engine（`planRunningPrescriptionWithRuleSet`）に委譲する。
 */
import {
  getActiveRuleSet,
  getRuleSetByIdentity,
  resolveSubjectProfile,
  type AggregationItem,
  type CoachActor,
  type CompetitionRef,
  type EnvelopeField,
  type Finding,
  type ResolvedRuleSet,
  type RuleSet,
  type RunningPrescriptionValue,
  type RunningSelection,
  type Subject,
  type Unit,
  type WeeklyHistoryInput,
} from "@/domain/running";
import {
  planRunningPrescriptionWithRuleSet,
  type CoachFieldEdit,
  type CoachOverride,
  type CoachReferenceInput,
  type EligibilityReason,
  type PlanRequest,
  type PlanResult,
} from "@/domain/running/planning";
import { AGGREGATE_ENVELOPE_FIELDS, coachOverrideSchema, isValidCalendarDate } from "@/domain/running/planning/schema";
import { evaluateFindingConfirmation, requiredConfirmationCodes } from "@/domain/running/planning/confirmation";
import type { TrainingPhase } from "@/domain/menu/constants";
import type { IsoDate } from "@/domain/running/types/primitives";
import { isoDateTimeSchema } from "@/domain/running/types/primitives";
import { runningMenuContextSchema, type RunningMenuContext } from "@/domain/running/persistence/menuContext";
import { buildProvenance, provenanceSchema, type Provenance } from "@/domain/running/persistence/provenance";
import {
  RunningPersistenceError,
  projectRunningPrescription,
  type RunningMenuItemPersistInput,
} from "@/domain/running/persistence/runningItem";
import { runningPrescriptionSchema } from "@/domain/running/types/prescription";
import { renderRationaleJa } from "@/domain/running/rationale/render-ja";
import { findMenu, findMenuIdForItem, type MenuDetail, type MenuItemDetail } from "@/infra/repositories/menu-repository";
import { createRunningMenuItem, updateRunningMenuItem } from "@/infra/repositories/running-item-repository";
import { listCompetitionRefs } from "@/infra/repositories/competition-repository";
import { listLoadHistory } from "@/infra/repositories/load-history-repository";
import { engineVersion } from "./_engine-version";
import { getCoachActorForServer } from "./_actor";

type CoachOverrideTarget = CoachOverride["target"];

// ---------------------------------------------------------------------------
// 拒否理由（安全な日本語メッセージへ変換するのは running-actions.ts 側）
// ---------------------------------------------------------------------------

export type RunningActionRejection =
  | { code: "MENU_NOT_FOUND" }
  | { code: "BLOCK_NOT_FOUND" }
  | { code: "ITEM_NOT_FOUND" }
  | { code: "ITEM_NOT_RUNNING_V2" }
  | { code: "RUNNING_CONTEXT_MISSING" }
  | { code: "RUNNING_CONTEXT_INVALID" }
  | { code: "PLANNED_DATE_REQUIRED" }
  | { code: "RULESET_VERSION_NOT_FOUND" }
  | { code: "RULESET_IDENTITY_MISMATCH" }
  | { code: "REPLAN_INPUT_SNAPSHOT_MISSING" }
  | { code: "COACH_EDIT_FIELD_NOT_SUPPORTED"; field: EnvelopeField }
  | {
      code: "PLAN_INELIGIBLE";
      reasons: readonly EligibilityReason[];
      findings: readonly Finding[];
      /** [R10-B4A.2] この Method の RuleSet（MethodMeta.allowedIntensityReferences）がコーチ入力の TARGET_SPLIT を受け付けるか。 */
      acceptsCoachTargetSplit: boolean;
    }
  | { code: "PLAN_BLOCKED"; findings: readonly Finding[] }
  /** [R10-B4A] 現在の plan 結果に、コーチの明示確認が足りない REQUIRE_CONFIRMATION がある。 */
  | { code: "CONFIRMATION_REQUIRED"; requiredFindingCodes: readonly string[]; findings: readonly Finding[] }
  /** [R10-B4A] 現在の plan 結果に存在しない code の確認が送られてきた（以前の結果の確認を流用しない）。 */
  | { code: "CONFIRMATION_STATE_STALE"; requiredFindingCodes: readonly string[]; findings: readonly Finding[] }
  /** [R10-B4A] 新しい override が domain の CoachOverride schema を満たさない（confirmedTwice / reason 等）。path だけを返す。 */
  | { code: "OVERRIDE_INPUT_INVALID"; paths: readonly string[] }
  /** [R10-B4A] 保存済み override に確認の記録が無く（または不足し）、CoachOverride として再構築できない。 */
  | { code: "OVERRIDE_HISTORY_UNCONFIRMED" }
  | { code: "PERSISTENCE_INVALID"; issues: readonly string[] };

export class RunningActionError extends Error {
  readonly rejection: RunningActionRejection;
  constructor(rejection: RunningActionRejection) {
    super(`running action rejected: ${rejection.code}`);
    this.name = "RunningActionError";
    this.rejection = rejection;
  }
}

function reject(rejection: RunningActionRejection): never {
  throw new RunningActionError(rejection);
}

// ---------------------------------------------------------------------------
// Menu / MenuItem の読み取り
// ---------------------------------------------------------------------------

async function loadMenu(menuId: string): Promise<MenuDetail> {
  const menu = await findMenu(menuId);
  if (!menu) reject({ code: "MENU_NOT_FOUND" });
  return menu;
}

async function loadMenuContainingItem(itemId: string): Promise<MenuDetail> {
  const menuId = await findMenuIdForItem(itemId);
  if (!menuId) reject({ code: "ITEM_NOT_FOUND" });
  return loadMenu(menuId);
}

function findBlock(menu: MenuDetail, blockId: string): void {
  if (!menu.blocks.some((b) => b.id === blockId)) reject({ code: "BLOCK_NOT_FOUND" });
}

function findItem(menu: MenuDetail, itemId: string): MenuItemDetail {
  for (const block of menu.blocks) {
    const item = block.items.find((i) => i.id === itemId);
    if (item) return item;
  }
  return reject({ code: "ITEM_NOT_FOUND" });
}

function requireRunningV2(item: MenuItemDetail): void {
  if (item.prescriptionKind !== "RUNNING_V2") reject({ code: "ITEM_NOT_RUNNING_V2" });
}

/** 保存済み prescriptionJson を検証して返す（壊れていれば拒否。読込は旧 schemaVersion=1 snapshot も許す）。 */
function parseStoredPrescription(item: MenuItemDetail): RunningPrescriptionValue {
  if (item.prescriptionJson === null) reject({ code: "ITEM_NOT_RUNNING_V2" });
  const parsed = runningPrescriptionSchema.safeParse(JSON.parse(item.prescriptionJson));
  if (!parsed.success) reject({ code: "PERSISTENCE_INVALID", issues: ["prescriptionJson を読めません"] });
  return parsed.data;
}

function parseStoredProvenance(item: MenuItemDetail): Provenance {
  if (item.provenanceJson === null) reject({ code: "PERSISTENCE_INVALID", issues: ["provenanceJson がありません"] });
  const parsed = provenanceSchema.safeParse(JSON.parse(item.provenanceJson));
  if (!parsed.success) reject({ code: "PERSISTENCE_INVALID", issues: ["provenanceJson を読めません"] });
  return parsed.data;
}

function parseRunningMenuContext(menu: MenuDetail): RunningMenuContext {
  if (menu.runningContextJson === null) reject({ code: "RUNNING_CONTEXT_MISSING" });
  const parsed = runningMenuContextSchema.safeParse(JSON.parse(menu.runningContextJson));
  if (!parsed.success) reject({ code: "RUNNING_CONTEXT_INVALID" });
  return parsed.data;
}

/**
 * [R10-B1 §14/§15/§18] plannedDate ?? today は R10 のどの application path でも使わない。
 * plannedDate が無ければ、どの操作であっても明示的に拒否する（edit/override も含む。
 * `PlanRequest.planningDate` は必須フィールードで、`resolveSubjectProfile` の `asOf` として
 * 年齢帯・成熟度・記録の鮮度判定に実際に使われるため、代わりの日付を作らずここで止める）。
 */
function requirePlannedDate(context: RunningMenuContext): IsoDate {
  if (context.plannedDate === null || !isValidCalendarDate(context.plannedDate)) reject({ code: "PLANNED_DATE_REQUIRED" });
  return context.plannedDate;
}

// ---------------------------------------------------------------------------
// RunningMenuContext → Subject（§19 D9: subject の source of truth）
// ---------------------------------------------------------------------------

/**
 * 保存された RunningMenuContext（健康情報を持たない永続化用の縮小版）から、
 * planning が要求する完全な GROUP Subject を組み立てる。
 * `birthDate` は RunningMenuContext に無い（プライバシー上保存しない設計）ため、
 * 常に null で個々の member を表す（年齢帯は `ageBandOverride` で判定する既存規約どおり）。
 */
function subjectFromContext(context: RunningMenuContext): Subject {
  return {
    kind: "GROUP",
    profile: {
      label: context.subject.label,
      members: context.subject.members.map((m) => ({
        birthDate: null,
        ageBandOverride: m.ageBandOverride,
        maturity: { status: m.maturity.status, confidence: m.maturity.confidence, method: m.maturity.method, assessedAt: m.maturity.assessedAt },
        trainingAge: m.trainingAge,
        primaryEvent: m.primaryEvent,
      })),
      memberCountHint: context.subject.memberCountHint,
      // menuContext.availableMinutes が正の情報源（§11 の集計に使う値）。二重に持たない。
      availableMinutes: null,
      allowAdvancedMethods: context.subject.allowAdvancedMethods,
    },
  } as Subject;
}

// ---------------------------------------------------------------------------
// otherItems（§19 D9: 現在の MenuItem から再導出）
// ---------------------------------------------------------------------------

/** legacy MenuItem に Exercise が無い（自由入力）ときの category fallback。RuleSet 側で必ず UNKNOWN 扱いになる。 */
const LEGACY_NO_EXERCISE_CATEGORY = "OTHER";

function otherAggregationItems(menu: MenuDetail, excludeItemId: string | null): AggregationItem[] {
  const items: AggregationItem[] = [];
  for (const block of menu.blocks) {
    for (const item of block.items) {
      if (item.id === excludeItemId) continue;
      if (item.prescriptionKind === "RUNNING_V2") {
        if (item.prescriptionJson === null) continue; // 壊れている項目は集計に含めない（§17.3 と同じ保守的扱い）
        const parsed = runningPrescriptionSchema.safeParse(JSON.parse(item.prescriptionJson));
        if (parsed.success) items.push({ kind: "RUNNING_V2", prescription: parsed.data });
        continue;
      }
      items.push({
        kind: "LEGACY",
        item: {
          category: item.exercise?.category ?? LEGACY_NO_EXERCISE_CATEGORY,
          sets: item.sets,
          reps: item.reps,
          distanceMeters: item.distanceMeters,
          durationSeconds: item.durationSeconds,
          restSeconds: item.restSeconds,
        },
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// history（§19 D9: load-history repository から再導出）
// ---------------------------------------------------------------------------

const HISTORY_WINDOW_HOURS = 24 * 28;

/**
 * [R10-B1 設計判断] load-history-repository は実際のセッション記録を返すが、
 * 「記録に無い活動が無かった」ことまでは確認できない（§12 の DailyActivitySummary 契約。
 * コーチが「他に活動なし」を明示確認する UI は R11）。そのため、events は実データを渡しつつ、
 * coverage は常に `PARTIAL`（記録はあるが完全性は確認できていない）にする。`dailyActivity7d` は
 * 空のまま（0 埋めで「休養日」を捏造しない）。history=null にはしない（せっかく読めた記録を
 * 無かったことにしない）。
 */
async function weeklyHistoryAsOf(asOf: Date): Promise<WeeklyHistoryInput> {
  const { events } = await listLoadHistory({ asOf, windowHours: HISTORY_WINDOW_HOURS });
  return {
    events,
    coverage72h: "PARTIAL",
    coverage7d: "PARTIAL",
    coverage28d: "PARTIAL",
    dailyActivity7d: [],
  };
}

// ---------------------------------------------------------------------------
// competitions（§19 D9: Competition repository から再導出。read-only）
// ---------------------------------------------------------------------------

// [R10-B2.1] session 評価と同じ共有 adapter を使う（開催期間の endDate を落とさない）。
async function competitionRefs(): Promise<CompetitionRef[]> {
  return listCompetitionRefs();
}

// ---------------------------------------------------------------------------
// coachReference（保存済み prescriptionJson から再導出。Provenance ではない）
// ---------------------------------------------------------------------------

const COACH_REFERENCE_KINDS = ["RACE_PACE", "TARGET_SPLIT", "VELOCITY_DECREMENT", "COACH_DEFINED"] as const;

/**
 * [R10-B1 監査結果] `PlanRequest.coachReference` は Provenance に保存されていないが、
 * plan 済みの `prescription.intensity.reference` がコーチ入力 kind（RACE_PACE / TARGET_SPLIT /
 * VELOCITY_DECREMENT / COACH_DEFINED）のときは、build.ts がその値をそのまま `intensity.reference`
 * へコピーする（`individualize.ts` の `finish({reference: coachRef, ...})`）ため、保存済み処方 JSON から
 * 完全に復元できる。エンジン導出の kind（MEASURED_VMAX 等）のときは null（エンジンが再導出する）。
 */
function coachReferenceFromPrescription(p: RunningPrescriptionValue): CoachReferenceInput | null {
  const ref = p.intensity.reference;
  return (COACH_REFERENCE_KINDS as readonly string[]).includes(ref.kind) ? (ref as CoachReferenceInput) : null;
}

// ---------------------------------------------------------------------------
// coachEdits / overrides の再導出（Provenance の履歴が source of truth）
// ---------------------------------------------------------------------------

/**
 * EnvelopeField → Unit。フィールド名自体が単位を一意に決める（`rules/schema.ts` の
 * RuleSet cross-validation 内部にある `expectedUnitByField` と同じ対応）。ここは
 * CoachFieldEdit 再構築専用の最小限のコピーで、生理学的な数値ポリシーではない。
 */
const ENVELOPE_FIELD_UNIT: Record<EnvelopeField, Unit> = {
  repDistanceM: "m",
  buildUpM: "m",
  flyZoneM: "m",
  decelerationM: "m",
  repDurationS: "s",
  repsPerSet: "reps",
  sets: "sets",
  totalReps: "reps",
  repRestS: "s",
  setRestS: "s",
  intraRepRestS: "s",
  sessionVolumeM: "m",
  flyVolumeM: "m",
  intensityPercent: "percent",
  attempts: "reps",
  vdecPercent: "percent",
};

/**
 * [R10-B1 既知の制約 → R10-B4A で方針確定] 以下の5フィールドは aggregate / constraint 値で、保存済み処方 JSON の中に
 * 一意に対応する一次 FieldValue が無い（totalReps は sets×repsPerSet の結果、sessionVolumeM / flyVolumeM は総量、
 * attempts / vdecPercent も同様）。**直接 edit の対象にしない**（EnvelopeField に存在することと直接編集できることは
 * 同義ではない）。変更後の値から一次入力を逆算する（sets を勝手に変える・距離を割り戻す等）ことはしない。
 */
const UNSUPPORTED_EDIT_FIELDS: readonly EnvelopeField[] = AGGREGATE_ENVELOPE_FIELDS;

function currentEnvelopeFieldValue(p: RunningPrescriptionValue, field: EnvelopeField): number | null {
  switch (field) {
    case "repDistanceM":
      return p.rep.kind === "DISTANCE" ? p.rep.distanceM.value : null;
    case "buildUpM":
      return p.rep.kind === "FLY" ? p.rep.buildUpDistanceM.value : null;
    case "flyZoneM":
      return p.rep.kind === "FLY" ? p.rep.flyZoneDistanceM.value : null;
    case "decelerationM":
      return p.rep.kind === "FLY" ? p.rep.decelerationDistanceM : null;
    case "repDurationS":
      return p.rep.kind === "DURATION" ? p.rep.durationS.value : null;
    case "repsPerSet":
      return p.repsPerSet.value;
    case "sets":
      return p.sets.value;
    case "repRestS":
      return p.rest.repRestS.value;
    case "setRestS":
      return p.rest.setRestS?.value ?? null;
    case "intraRepRestS":
      return p.rest.intraRepRestS?.value ?? null;
    case "intensityPercent":
      // [R10-B4A] 区間の中央値を「変更前の値」として捏造しない。1点（lower === upper）のときだけ現在値とみなす。
      return p.intensity.target !== null &&
        p.intensity.target.unit === "percent" &&
        p.intensity.target.lower !== null &&
        p.intensity.target.lower === p.intensity.target.upper
        ? p.intensity.target.lower
        : null;
    case "totalReps":
    case "sessionVolumeM":
    case "flyVolumeM":
    case "attempts":
    case "vdecPercent":
      return null;
  }
}

/** field をキーに最新の1件だけ残す（Provenance.coachEdits は append-only の履歴。配列順=時系列を仮定）。 */
function latestCoachEditsByField(history: Provenance["coachEdits"]): Map<EnvelopeField, Provenance["coachEdits"][number]> {
  const map = new Map<EnvelopeField, Provenance["coachEdits"][number]>();
  for (const entry of history) map.set(entry.field, entry);
  return map;
}

function coachFieldEditsForReplan(history: Provenance["coachEdits"]): CoachFieldEdit[] {
  return [...latestCoachEditsByField(history).values()].map((e) => ({ field: e.field, value: e.to, unit: ENVELOPE_FIELD_UNIT[e.field] }));
}

function overrideTargetKey(target: CoachOverrideTarget): string {
  if (target.kind === "ELIGIBILITY") return `E:${target.ruleId}`;
  if (target.kind === "READINESS") return `R:${target.action}`;
  return `F:${target.field}`;
}

function latestOverridesByTarget(history: Provenance["overrides"]): Map<string, Provenance["overrides"][number]> {
  const map = new Map<string, Provenance["overrides"][number]>();
  for (const entry of history) map.set(overrideTargetKey(entry.target), entry);
  return map;
}

/**
 * Provenance の override 履歴から CoachOverride[] を再構築する。
 * [R10-B4A] `confirmedTwice` は**保存時にコーチが実際に送った値**（`Provenance.overrides[].confirmedTwice`）だけを使い、
 * true へ自動昇格しない（記録の無い R10-B4A より前の履歴は false）。再構築した override は domain の
 * `coachOverrideSchema` にそのまま通し、満たさなければ（例: 確認記録の無い HARD_SAFETY / ELIGIBILITY）拒否する。
 */
function coachOverridesForReplan(history: Provenance["overrides"], actor: CoachActor): CoachOverride[] {
  return [...latestOverridesByTarget(history).values()].map((e) => {
    const parsed = coachOverrideSchema.safeParse({
      target: e.target,
      ...(e.target.kind === "FIELD" && e.to !== undefined ? { newValue: e.to } : {}),
      reason: e.reason,
      confirmedTwice: e.confirmedTwice === true,
      actor,
      at: e.at,
    });
    if (!parsed.success) reject({ code: "OVERRIDE_HISTORY_UNCONFIRMED" });
    return parsed.data;
  });
}

function nowAsIsoDateTime(): Provenance["coachEdits"][number]["at"] {
  return isoDateTimeSchema.parse(new Date().toISOString());
}

// ---------------------------------------------------------------------------
// RuleSet 選択（§16: edit/override = 保存済み厳密一致、new/recalculate = plannedDate 基準の active）
// ---------------------------------------------------------------------------

function resolveExactRuleSetOrReject(item: Pick<MenuItemDetail, "ruleSetVersion" | "ruleSetContentHash">): ResolvedRuleSet {
  if (item.ruleSetVersion === null || item.ruleSetContentHash === null) reject({ code: "ITEM_NOT_RUNNING_V2" });
  const result = getRuleSetByIdentity({ version: item.ruleSetVersion, contentHash: item.ruleSetContentHash });
  if (result.status === "REJECTED") {
    reject(result.issue === "VERSION_NOT_FOUND" ? { code: "RULESET_VERSION_NOT_FOUND" } : { code: "RULESET_IDENTITY_MISMATCH" });
  }
  return { ruleSet: result.ruleSet, contentHash: result.contentHash, isDraftFallback: false };
}

function resolveActiveRuleSetFor(plannedDate: IsoDate): ResolvedRuleSet {
  const active = getActiveRuleSet(plannedDate);
  return { ruleSet: active.ruleSet, contentHash: active.contentHash, isDraftFallback: active.isDraftFallback };
}

// ---------------------------------------------------------------------------
// PlanRequest の組み立て（§19 D9 の各フィールドの source of truth）
// ---------------------------------------------------------------------------

type ReplanBase = {
  menu: MenuDetail;
  context: RunningMenuContext;
  plannedDate: IsoDate;
  selection: RunningSelection;
  coachEdits: CoachFieldEdit[];
  overrides: CoachOverride[];
  coachReference: CoachReferenceInput | null;
  positionPreference: "LOWER" | "MIDDLE" | null;
  excludeItemId: string | null;
  /** [R10-B4A] コーチが今回の操作で明示確認した Finding code（そのまま domain へ渡す）。 */
  confirmedFindingCodes: readonly string[];
};

async function buildPlanRequest(base: ReplanBase): Promise<PlanRequest> {
  const { menu, context, plannedDate } = base;
  return {
    planningDate: plannedDate,
    selection: base.selection,
    subject: subjectFromContext(context),
    menuContext: {
      phase: menu.phase,
      plannedDate,
      plannedAt: context.plannedAt,
      competitions: await competitionRefs(),
      otherItems: otherAggregationItems(menu, base.excludeItemId),
      availableMinutes: context.availableMinutes,
    },
    // [R11] 当日 readiness 入力は R10 の GROUP planning には持ち込まない（§19 D9）。
    history: context.plannedAt !== null ? await weeklyHistoryAsOf(new Date(context.plannedAt)) : null,
    readiness: null,
    positionPreference: base.positionPreference,
    coachEdits: base.coachEdits,
    overrides: base.overrides,
    coachReference: base.coachReference,
    actor: getCoachActorForServer(),
    confirmedFindingCodes: [...base.confirmedFindingCodes],
  } as unknown as PlanRequest;
}

// ---------------------------------------------------------------------------
// Provenance の組み立て
// ---------------------------------------------------------------------------

/**
 * [R10-B1.1] `PlanResult` は内部で解決した `SubjectProfile`（ageBand・trainingAgeTier の実際の
 * 解決結果）を外へ返さないため、Provenance の監査用に同じ入力（subject/asOf/ruleSet）で
 * `resolveSubjectProfile()` をもう一度呼ぶ。ロジックを複製するのではなく、既存の公開・純粋関数を
 * 同じ引数でもう一度呼ぶだけ（結果は決定的に同じになる）。
 *
 * ageBand / trainingAgeTier は「入力状態を正直に記録する」監査ログとして扱う:
 *   - `profile.ageBand`（`ResolvedAgeBand = AgeBand | "UNKNOWN"`）をそのまま保存する。
 *     GROUP が空、または member の年齢帯が分からなければ "UNKNOWN"（U12 等へ偽装しない）。
 *   - `profile.trainingAgeKnown` が false のときは "UNKNOWN" を保存する。エンジン内部は
 *     dose 計算のために保守的な既定値（例: BEGINNER）へ倒すが、それは engine policy であって
 *     「実際に入力されていたか」とは別の事実なので、Provenance では前者を後者で上書きしない。
 */
function inputsDigestFor(args: {
  prescription: RunningPrescriptionValue;
  context: RunningMenuContext;
  plannedDate: IsoDate;
  phase: PlanRequest["menuContext"]["phase"];
  competitions: readonly CompetitionRef[];
  ruleSet: RuleSet;
}): Provenance["inputsDigest"] {
  const { prescription, context, plannedDate, phase, competitions, ruleSet } = args;
  const profile = resolveSubjectProfile({ subject: subjectFromContext(context), asOf: plannedDate, ruleSet });
  return {
    tier: prescription.tier,
    ageBand: profile.ageBand,
    maturityEffective: [...new Set(context.subject.members.map((m) => m.maturity.status))].sort().join("+") || "UNKNOWN",
    trainingAgeTier: profile.trainingAgeKnown ? profile.trainingAgeTier : "UNKNOWN",
    phase,
    plannedDate,
    // [R10-B1.1 §10] このメニューに登録されていた大会 context の安定した digest。
    // 「実際に window 判定へ match した大会だけ」を意味しない（§16.3 参照）。
    competitionWindows: competitions.map((c) => `${c.id}:${c.priority}`),
    referenceKinds: [prescription.intensity.reference.kind],
    // [R10-B1] weeklyHistoryAsOf は常に PARTIAL を返す（§19 の設計判断）。
    historyCoverage72h: "PARTIAL",
    readinessActions: [...prescription.readinessApplied],
  };
}

async function buildProvenanceFor(args: {
  prescription: RunningPrescriptionValue;
  context: RunningMenuContext;
  plannedDate: IsoDate;
  phase: PlanRequest["menuContext"]["phase"];
  ruleSet: RuleSet;
  coachEdits: Provenance["coachEdits"];
  overrides: Provenance["overrides"];
  findingConfirmations: NonNullable<Provenance["findingConfirmations"]>;
}): Promise<Provenance> {
  const { prescription, context, plannedDate, phase, ruleSet, coachEdits, overrides, findingConfirmations } = args;
  const competitions = await competitionRefs();
  return buildProvenance({
    prescription,
    engineVersion: engineVersion(),
    inputsDigest: inputsDigestFor({ prescription, context, plannedDate, phase, competitions, ruleSet }),
    coachEdits,
    overrides,
    aiReason: null,
    findingConfirmations,
  });
}

// ---------------------------------------------------------------------------
// plan() の実行と結果の分岐
// ---------------------------------------------------------------------------

type PlanOutcome = {
  prescription: RunningPrescriptionValue;
  sessionFindings: Finding[];
  /** [R10-B4A] 今回の結果に対してコーチが明示確認した code の監査記録（無ければ空）。 */
  findingConfirmations: NonNullable<Provenance["findingConfirmations"]>;
};

/**
 * [R10-B1 発見事項] `PlanResult.sessionFindings`（§11 の集計 Finding。AGG_* 等）は
 * `prescription.findings` の中には**入らない**（item scope と session scope は別フィールド）。
 * これはメニュー内の他項目に依存する一時的な評価であり、MenuItem の恒久的な状態ではないため
 * 永続化しない（他項目の追加・削除のたびに古くなる）。呼び出し元（Action）が保存結果と一緒に
 * 都度返し、将来の UI（R10-B3）がその場で表示できるようにする。
 */
function runPlan(request: PlanRequest, resolved: ResolvedRuleSet, confirmedFindingCodes: readonly string[]): PlanOutcome {
  const result: PlanResult = planRunningPrescriptionWithRuleSet(request, resolved);
  if (result.status === "INELIGIBLE") {
    // [R10-B4A.2] 基準が足りない理由を UI が案内できるよう、RuleSet のデータ（許可された参照 kind）だけを添える（判定はしない）。
    const methodMeta = resolved.ruleSet.methods.find((m) => m.method === request.selection.method);
    reject({
      code: "PLAN_INELIGIBLE",
      reasons: result.reasons,
      findings: result.findings,
      acceptsCoachTargetSplit: (methodMeta?.allowedIntensityReferences as readonly string[] | undefined)?.includes("TARGET_SPLIT") ?? false,
    });
  }
  if (result.status === "BLOCKED" && result.confirmationRequired === undefined) reject({ code: "PLAN_BLOCKED", findings: result.findings });

  // [R10-B4A] 確認は常に「現在の入力で再実行した結果」に対して判定する（以前の結果の確認を流用しない）。
  const currentFindings = result.status === "OK" ? [...result.prescription.findings, ...result.sessionFindings] : result.findings;
  const outcome = evaluateFindingConfirmation(requiredConfirmationCodes(currentFindings), confirmedFindingCodes);
  const confirmationFindings = currentFindings.filter((f) => f.severity === "REQUIRE_CONFIRMATION");
  if (outcome.kind === "CONFIRMATION_STATE_STALE") {
    reject({ code: "CONFIRMATION_STATE_STALE", requiredFindingCodes: outcome.requiredFindingCodes, findings: confirmationFindings });
  }
  if (outcome.kind === "CONFIRMATION_REQUIRED") {
    reject({ code: "CONFIRMATION_REQUIRED", requiredFindingCodes: outcome.requiredFindingCodes, findings: confirmationFindings });
  }
  // 確認がそろっていれば domain は OK を返す。そろっているのに BLOCKED なら確認では解除できない停止として扱う。
  if (result.status !== "OK") return reject({ code: "PLAN_BLOCKED", findings: result.findings });

  const at = nowAsIsoDateTime();
  return {
    prescription: result.prescription,
    sessionFindings: result.sessionFindings,
    findingConfirmations: outcome.confirmedCodes.map((code) => ({ code, at })),
  };
}

function persistInput(prescription: RunningPrescriptionValue, provenance: Provenance, note: string | null): RunningMenuItemPersistInput {
  return {
    prescriptionJson: JSON.stringify(prescription),
    provenanceJson: JSON.stringify(provenance),
    rationale: renderRationaleJa(prescription.rationale).join("\n"),
    note,
  };
}

function toPersistenceRejection(e: unknown): never {
  if (e instanceof RunningPersistenceError) reject({ code: "PERSISTENCE_INVALID", issues: e.issues });
  throw e;
}

// ---------------------------------------------------------------------------
// 公開 API（running-actions.ts から呼ぶ）
// ---------------------------------------------------------------------------

export type PlanNewRunningItemInput = {
  menuId: string;
  blockId: string;
  method: string;
  templateId: string;
  positionPreference: "LOWER" | "MIDDLE" | null;
  confirmedFindingCodes: readonly string[];
  /**
   * [R10-B4A.2] コーチが手入力した強度の基準（正規化済みの TARGET_SPLIT 等）。無ければ null。
   * どの Method で使えるかは domain（MethodMeta.allowedIntensityReferences）が検証する。
   */
  coachReference: CoachReferenceInput | null;
};

/** [R10-B1 §28] コーチから受け取るのは method/templateId/positionPreference だけ。他は server が解決する。 */
export async function planNewRunningItem(input: PlanNewRunningItemInput) {
  const menu = await loadMenu(input.menuId);
  findBlock(menu, input.blockId);
  const context = parseRunningMenuContext(menu);
  const plannedDate = requirePlannedDate(context);
  const resolved = resolveActiveRuleSetFor(plannedDate);
  const phase = menu.phase as TrainingPhase | null;

  const request = await buildPlanRequest({
    menu,
    context,
    plannedDate,
    selection: { method: input.method, templateId: input.templateId } as RunningSelection,
    coachEdits: [],
    overrides: [],
    coachReference: input.coachReference,
    positionPreference: input.positionPreference,
    excludeItemId: null,
    confirmedFindingCodes: input.confirmedFindingCodes,
  });
  const { prescription, sessionFindings, findingConfirmations } = runPlan(request, resolved, input.confirmedFindingCodes);
  const provenance = await buildProvenanceFor({
    prescription,
    context,
    plannedDate,
    phase,
    ruleSet: resolved.ruleSet,
    coachEdits: [],
    overrides: [],
    findingConfirmations,
  });

  let saved;
  try {
    saved = await createRunningMenuItem(input.blockId, persistInput(prescription, provenance, null));
  } catch (e) {
    return toPersistenceRejection(e);
  }
  return { item: saved, sessionFindings };
}

/** editRunningItem / overrideRunningItem 共通の準備（§16: 保存済み exact RuleSet を使う）。 */
async function loadForReplan(itemId: string) {
  const menu = await loadMenuContainingItem(itemId);
  const item = findItem(menu, itemId);
  requireRunningV2(item);
  const current = parseStoredPrescription(item);
  if (current.planningControls === undefined) reject({ code: "REPLAN_INPUT_SNAPSHOT_MISSING" });
  const provenance = parseStoredProvenance(item);
  const context = parseRunningMenuContext(menu);
  const plannedDate = requirePlannedDate(context);
  const resolved = resolveExactRuleSetOrReject(item);
  return { menu, item, current, provenance, context, plannedDate, resolved };
}

async function finishReplan(args: {
  menu: MenuDetail;
  item: MenuItemDetail;
  context: RunningMenuContext;
  plannedDate: IsoDate;
  resolved: ResolvedRuleSet;
  current: RunningPrescriptionValue;
  coachEdits: CoachFieldEdit[];
  overrides: CoachOverride[];
  newProvenanceCoachEdits: Provenance["coachEdits"];
  newProvenanceOverrides: Provenance["overrides"];
  /** [R10-B4A] 今回の操作でコーチが明示確認した code。以前の findingConfirmations は引き継がない。 */
  confirmedFindingCodes: readonly string[];
  /**
   * [R10-B4A.2] コーチが明示的に更新した強度の基準。省略時は保存済み処方の参照（コーチ入力 kind のとき）を
   * そのまま再利用する（exact 値を保つ。recalculate / override でも同じ）。
   */
  coachReference?: CoachReferenceInput;
}) {
  const request = await buildPlanRequest({
    menu: args.menu,
    context: args.context,
    plannedDate: args.plannedDate,
    selection: { method: args.item.runningMethod, templateId: args.item.sessionTemplateId } as RunningSelection,
    coachEdits: args.coachEdits,
    overrides: args.overrides,
    coachReference: args.coachReference ?? coachReferenceFromPrescription(args.current),
    positionPreference: args.current.planningControls!.positionPreference,
    excludeItemId: args.item.id,
    confirmedFindingCodes: args.confirmedFindingCodes,
  });
  const { prescription, sessionFindings, findingConfirmations } = runPlan(request, args.resolved, args.confirmedFindingCodes);
  const provenanceOut = await buildProvenanceFor({
    prescription,
    context: args.context,
    plannedDate: args.plannedDate,
    phase: args.menu.phase as TrainingPhase | null,
    ruleSet: args.resolved.ruleSet,
    coachEdits: args.newProvenanceCoachEdits,
    overrides: args.newProvenanceOverrides,
    findingConfirmations,
  });

  let saved;
  try {
    saved = await updateRunningMenuItem(args.item.id, persistInput(prescription, provenanceOut, args.item.note));
  } catch (e) {
    return toPersistenceRejection(e);
  }
  return { item: saved, sessionFindings };
}

export type EditRunningItemInput = {
  itemId: string;
  /** 1フィールドの数値編集（`coachReference` だけを更新する場合は省略）。 */
  fieldEdit?: { field: EnvelopeField; value: number };
  /** [R10-B4A.2] 強度の基準（TARGET_SPLIT 等）の明示更新。省略時は保存済みの参照をそのまま使う。 */
  coachReference?: CoachReferenceInput;
  confirmedFindingCodes: readonly string[];
};

/**
 * [R10-B1 §31/§32] coachEditable 内の1フィールド編集。domain の再検証（hard safety 含む）を必ず通す。
 * [R10-B4A.2] 強度の基準（coachReference）の明示更新も受け付け、新しい値で plan を再実行する。基準の変更を
 * coachEdits（EnvelopeField の編集履歴）へ偽装しない（実値は処方の intensity.reference に保存される）。
 */
export async function editRunningItem(input: EditRunningItemInput) {
  const fieldEdit = input.fieldEdit;
  if (fieldEdit === undefined && input.coachReference === undefined) {
    // Action の入力検証が保証する前提（数値の編集か基準の更新のどちらかは必ずある）。
    throw new Error("editRunningItem には fieldEdit か coachReference のどちらかが必要です");
  }
  if (fieldEdit !== undefined && UNSUPPORTED_EDIT_FIELDS.includes(fieldEdit.field)) {
    reject({ code: "COACH_EDIT_FIELD_NOT_SUPPORTED", field: fieldEdit.field });
  }

  const ctx = await loadForReplan(input.itemId);
  let coachEditHistory = ctx.provenance.coachEdits;
  let overrides = ctx.provenance.overrides;
  if (fieldEdit !== undefined) {
    const from = currentEnvelopeFieldValue(ctx.current, fieldEdit.field);
    if (from === null) reject({ code: "COACH_EDIT_FIELD_NOT_SUPPORTED", field: fieldEdit.field });
    // [R10-B1] 同じ field に coachEdit と FIELD override を同時に PlanRequest へ渡すと domain の
    // validation が拒否する（§18「出所の曖昧さ」防止）。今回の edit がその field を新たに「所有」するため、
    // その field を対象にしていた既存の override（あれば）は落とす（override → edit で上書きされる）。
    overrides = overrides.filter((o) => !(o.target.kind === "FIELD" && o.target.field === fieldEdit.field));
    coachEditHistory = [...coachEditHistory, { at: nowAsIsoDateTime(), field: fieldEdit.field, from, to: fieldEdit.value }];
  }
  return finishReplan({
    ...ctx,
    coachEdits: coachFieldEditsForReplan(coachEditHistory),
    overrides: coachOverridesForReplan(overrides, getCoachActorForServer()),
    newProvenanceCoachEdits: coachEditHistory,
    newProvenanceOverrides: overrides,
    confirmedFindingCodes: input.confirmedFindingCodes,
    ...(input.coachReference !== undefined ? { coachReference: input.coachReference } : {}),
  });
}

export type OverrideRunningItemInput = {
  itemId: string;
  target: CoachOverrideTarget;
  newValue?: number;
  reason: string;
  /** [R10-B4A] コーチが Action で明示的に送った値。service で補わない・true に昇格しない。 */
  confirmedTwice: boolean;
  confirmedFindingCodes: readonly string[];
};

/**
 * [R10-B1 §33] CoachActor 必須。
 * [R10-B4A] confirmedTwice / reason 長さ等は、Action の入力値をそのまま domain の `coachOverrideSchema` に渡して検証する
 * （どの target で二重確認が必要かを Action / service に複製しない）。override したこと自体を Finding の確認とはみなさない。
 */
export async function overrideRunningItem(input: OverrideRunningItemInput) {
  const ctx = await loadForReplan(input.itemId);
  const actor = getCoachActorForServer();
  const at = nowAsIsoDateTime();
  const newOverride = coachOverrideSchema.safeParse({
    target: input.target,
    ...(input.newValue !== undefined ? { newValue: input.newValue } : {}),
    reason: input.reason,
    confirmedTwice: input.confirmedTwice,
    actor,
    at,
  });
  if (!newOverride.success) {
    reject({ code: "OVERRIDE_INPUT_INVALID", paths: [...new Set(newOverride.error.issues.map((i) => String(i.path[0] ?? "")))] });
  }
  // [R10-B1] 逆方向の同じ理由: 今回の override がその field を新たに「所有」するため、
  // その field を対象にしていた既存の coachEdit（あれば）は落とす（edit → override で上書きされる）。
  const targetField = input.target.kind === "FIELD" ? input.target.field : null;
  const coachEditsWithoutThisField = targetField === null ? ctx.provenance.coachEdits : ctx.provenance.coachEdits.filter((e) => e.field !== targetField);
  const newOverrideHistory: Provenance["overrides"] = [
    ...ctx.provenance.overrides,
    {
      at,
      target: input.target,
      ...(input.newValue !== undefined ? { to: input.newValue } : {}),
      reason: input.reason,
      confirmedTwice: input.confirmedTwice,
    },
  ];
  return finishReplan({
    ...ctx,
    coachEdits: coachFieldEditsForReplan(coachEditsWithoutThisField),
    overrides: coachOverridesForReplan(newOverrideHistory, actor),
    newProvenanceCoachEdits: coachEditsWithoutThisField,
    newProvenanceOverrides: newOverrideHistory,
    confirmedFindingCodes: input.confirmedFindingCodes,
  });
}

export type RecalculateRunningItemInput = { itemId: string; confirmedFindingCodes: readonly string[] };

/**
 * [R10-B1 §35/§36] 明示的な再計算だけが active 版へ更新する。coachEdits はそのまま新しい RuleSet へ渡し、
 * 新しい envelope の coachEditable 範囲内かどうかは domain の plan 自体が再検証する
 * （範囲外なら PLAN_BLOCKED として拒否し、保存しない＝黙ってクランプしない）。override は自動再承認せず、
 * 空にして落とす（無条件 carry 禁止。既存の override があったかどうかは `overridesDropped` で呼び出し側へ返す）。
 * 既存の SessionItem には一切影響しない（コピー済みのスナップショットのため、この更新は伝播しない）。
 */
export async function recalculateRunningItem(input: RecalculateRunningItemInput) {
  const ctx = await loadForReplan(input.itemId);
  const hadOverrides = ctx.provenance.overrides.length > 0;
  const active = resolveActiveRuleSetFor(ctx.plannedDate);

  const { item: saved, sessionFindings } = await finishReplan({
    ...ctx,
    resolved: active,
    coachEdits: coachFieldEditsForReplan(ctx.provenance.coachEdits),
    overrides: [],
    newProvenanceCoachEdits: ctx.provenance.coachEdits,
    newProvenanceOverrides: [],
    confirmedFindingCodes: input.confirmedFindingCodes,
  });
  return { item: saved, sessionFindings, overridesDropped: hadOverrides };
}

export { projectRunningPrescription };
