/**
 * Running Prescription Engine v2 — RUNNING_V2 MenuItem の永続化レコード（§15.2・§16.1・§19.2）。
 *
 * [R9] repository は plan() を呼ばない。domain から受け取った**完成済みの処方**（prescriptionJson）と
 * provenanceJson・rationale（生成時点の日本語テキスト）を検証し、列へ投影するだけ。
 *   - 検証（parse）と保存（入力文字列そのもの）を分離する。parse → stringify した別文字列に置き換えない。
 *   - 構造化列と JSON で同じ概念を持つ箇所は一致必須（不一致の入力は保存しない）。
 *   - 既存列（legacy projection）も必ず埋める。`note` はコーチの自由記述だけで、rationale を書き込まない。
 */
import type { RunningPrescriptionValue } from "../types/prescription";
import { runningPrescriptionSchema } from "../types/prescription";
import { parseJsonColumn } from "./jsonColumn";
import {
  PRESCRIPTION_JSON_MAX_BYTES,
  PROVENANCE_JSON_MAX_BYTES,
  RATIONALE_MAX_CHARS,
  codePointLength,
  jsonByteLimitIssue,
} from "./limits";
import { provenancePrescriptionIssues, provenanceSchema, type Provenance } from "./provenance";

export const DISPLAY_NAME_MAX_CHARS = 160;
export const NOTE_MAX_CHARS = 1000;

export class RunningPersistenceError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`RUNNING_V2 の保存内容が不正です: ${issues.join(" / ")}`);
    this.name = "RunningPersistenceError";
    this.issues = issues;
  }
}

/** repository の保存 API が受け取る入力（列の値は処方から投影する）。 */
export type RunningMenuItemPersistInput = {
  prescriptionJson: string;
  provenanceJson: string;
  /** plan 時点でレンダリング済みの日本語テキスト（後から再レンダリングしない）。 */
  rationale: string;
  /** コーチの自由記述のみ。 */
  note: string | null;
};

/** MenuItem の RUNNING_V2 行として書き込む列（id / menuBlockId / sortOrder 以外）。 */
export type RunningMenuItemRecord = {
  prescriptionKind: "RUNNING_V2";
  exerciseId: null;
  displayName: string;
  sets: number;
  reps: number;
  distanceMeters: number | null;
  durationSeconds: number | null;
  restSeconds: number;
  intensityPercent: number | null;
  loadKg: null;
  note: string | null;
  runningMethod: string;
  sessionTemplateId: string;
  recoveryStructure: string | null;
  buildUpDistanceMeters: number | null;
  flyZoneDistanceMeters: number | null;
  setRestSeconds: number | null;
  intraRepRestSeconds: number | null;
  intensityReferenceKind: string;
  prescriptionConfidence: string;
  ruleSetVersion: string;
  ruleSetContentHash: string;
  prescriptionJson: string;
  provenanceJson: string;
  rationale: string;
};

/** 処方から導出する列（displayName を除き、保存時に一致を要求する）。 */
type ProjectedColumns = Omit<RunningMenuItemRecord, "note" | "prescriptionJson" | "provenanceJson" | "rationale">;

// ---------------------------------------------------------------------------
// projection（§15.2）
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** plan 時点の template 日本語ラベル（rationale の TEMPLATE_SELECTED 行に snapshot されている）。 */
function templateLabelOf(p: RunningPrescriptionValue): string {
  const line = p.rationale.find((l) => l.code === "TEMPLATE_SELECTED");
  const label = line?.params?.templateLabelJa;
  return typeof label === "string" && label.trim() !== "" ? label : "走トレーニング";
}

function repDistanceMeters(p: RunningPrescriptionValue): number | null {
  const rep = p.rep;
  switch (rep.kind) {
    case "DISTANCE":
      return rep.distanceM.value;
    case "FLY":
      // 減速区間は表示距離に足さない（§15.2: build-up + fly）
      return rep.buildUpDistanceM.value + rep.flyZoneDistanceM.value;
    case "DURATION":
      return null;
    case "SPLIT":
      return rep.segments.reduce((sum, s) => sum + s.distanceM, 0);
    case "ATTEMPTS":
      return rep.approachDistanceM?.value ?? null;
  }
}

function repDetailJa(p: RunningPrescriptionValue): string | null {
  const rep = p.rep;
  switch (rep.kind) {
    case "DISTANCE":
      return `${formatNumber(rep.distanceM.value)}m`;
    case "FLY":
      return `助走${formatNumber(rep.buildUpDistanceM.value)}m＋フライ${formatNumber(rep.flyZoneDistanceM.value)}m`;
    case "DURATION":
      return `${formatNumber(rep.durationS.value)}秒`;
    case "SPLIT":
      return rep.segments.map((s) => `${formatNumber(s.distanceM)}m`).join("+");
    case "ATTEMPTS":
      return rep.approachDistanceM === null ? null : `助走${formatNumber(rep.approachDistanceM.value)}m`;
  }
}

/** §15.2: 数値%目標がある場合だけ区間中央値を整数化。MAX_INTENT / RELAXED_SUBMAX と秒の目標は null。 */
function intensityPercentOf(p: RunningPrescriptionValue): number | null {
  const kind = p.intensity.reference.kind;
  if (kind === "MAX_INTENT" || kind === "RELAXED_SUBMAX") return null;
  const target = p.intensity.target;
  if (target === null || target.unit !== "percent" || target.lower === null || target.upper === null) return null;
  return Math.round((target.lower + target.upper) / 2);
}

export function projectRunningPrescription(p: RunningPrescriptionValue): ProjectedColumns {
  const detail = repDetailJa(p);
  const counts = `${formatNumber(p.sets.value)}セット×${formatNumber(p.repsPerSet.value)}本`;
  const fly = p.rep.kind === "FLY" ? p.rep : null;
  return {
    prescriptionKind: "RUNNING_V2",
    exerciseId: null,
    displayName: `${templateLabelOf(p)}（${detail === null ? counts : `${detail}・${counts}`}）`,
    sets: p.sets.value,
    reps: p.repsPerSet.value,
    distanceMeters: repDistanceMeters(p),
    durationSeconds: p.rep.kind === "DURATION" ? p.rep.durationS.value : null,
    restSeconds: p.rest.repRestS.value,
    intensityPercent: intensityPercentOf(p),
    loadKg: null,
    runningMethod: p.method,
    sessionTemplateId: p.templateId,
    recoveryStructure: p.recoveryStructure,
    buildUpDistanceMeters: fly?.buildUpDistanceM.value ?? null,
    flyZoneDistanceMeters: fly?.flyZoneDistanceM.value ?? null,
    setRestSeconds: p.rest.setRestS?.value ?? null,
    intraRepRestSeconds: p.rest.intraRepRestS?.value ?? null,
    intensityReferenceKind: p.intensity.reference.kind,
    prescriptionConfidence: p.confidence.prescription,
    ruleSetVersion: p.ruleSet.version,
    ruleSetContentHash: p.ruleSet.contentHash,
  };
}

// ---------------------------------------------------------------------------
// validation（§19.2）
// ---------------------------------------------------------------------------

const REQUIRED_NON_NULL_COLUMNS = [
  "runningMethod",
  "sessionTemplateId",
  "ruleSetVersion",
  "ruleSetContentHash",
  "prescriptionJson",
  "provenanceJson",
  "rationale",
  "sets",
  "reps",
] as const;

/** 構造化列 / legacy 列のうち、処方 JSON と同じ概念を持つもの（一致必須）。 */
const CONSISTENCY_COLUMNS = [
  "sets",
  "reps",
  "distanceMeters",
  "durationSeconds",
  "restSeconds",
  "intensityPercent",
  "loadKg",
  "runningMethod",
  "sessionTemplateId",
  "recoveryStructure",
  "buildUpDistanceMeters",
  "flyZoneDistanceMeters",
  "setRestSeconds",
  "intraRepRestSeconds",
  "intensityReferenceKind",
  "prescriptionConfidence",
  "ruleSetVersion",
  "ruleSetContentHash",
] as const;

/** SQLite の Int 列（小数は丸めずに拒否する）。 */
const INT_COLUMNS = ["sets", "reps", "durationSeconds", "restSeconds", "intensityPercent", "setRestSeconds", "intraRepRestSeconds"] as const;

export type ValidatedRunningMenuItem = {
  prescription: RunningPrescriptionValue;
  provenance: Provenance;
};

/**
 * RUNNING_V2 の MenuItem 列を書込み前（WRITE）または読込み時（READ）に検証する。1つでも問題があれば
 * `RunningPersistenceError`（issues は値を含まない説明文）を投げる。
 *   - WRITE: R9 以降の新規保存。処方 JSON に `loadSnapshot` が必須（repository が RuleSet から補完しない）
 *   - READ: 保存済みの値。loadSnapshot の無い旧 snapshot（schemaVersion=1 の R8 まで）も読める
 */
export function validateRunningMenuItemRecord(
  record: Readonly<Record<string, unknown>>,
  mode: "WRITE" | "READ" = "WRITE",
): ValidatedRunningMenuItem {
  const issues: string[] = [];

  if (record.prescriptionKind !== "RUNNING_V2") issues.push("prescriptionKind は RUNNING_V2 である必要があります");
  if (record.exerciseId !== null) issues.push("RUNNING_V2 の exerciseId は null である必要があります（Exercise と永続的に関連付けない）");
  if (record.loadKg !== null) issues.push("RUNNING_V2 の loadKg は null である必要があります");
  for (const column of REQUIRED_NON_NULL_COLUMNS) {
    if (record[column] === null || record[column] === undefined) issues.push(`${column} は RUNNING_V2 で必須です`);
  }

  const displayName = record.displayName;
  if (typeof displayName !== "string" || displayName.trim() === "") {
    issues.push("displayName は必須です");
  } else if (codePointLength(displayName) > DISPLAY_NAME_MAX_CHARS) {
    issues.push(`displayName は ${DISPLAY_NAME_MAX_CHARS} 文字以内である必要があります`);
  }
  const note = record.note;
  if (note !== null && (typeof note !== "string" || codePointLength(note) > NOTE_MAX_CHARS)) {
    issues.push(`note は null または ${NOTE_MAX_CHARS} 文字以内の文字列である必要があります`);
  }

  const rationale = record.rationale;
  if (typeof rationale === "string") {
    if (rationale.trim() === "") issues.push("rationale は空にできません");
    if (codePointLength(rationale) > RATIONALE_MAX_CHARS) {
      issues.push(`rationale は ${RATIONALE_MAX_CHARS} 文字以内である必要があります（${codePointLength(rationale)} 文字）`);
    }
  } else if (rationale !== null && rationale !== undefined) {
    issues.push("rationale は文字列である必要があります");
  }

  for (const column of INT_COLUMNS) {
    const v = record[column];
    if (v !== null && v !== undefined && !(typeof v === "number" && Number.isInteger(v))) {
      issues.push(`${column} は整数である必要があります`);
    }
  }

  const prescriptionRaw = typeof record.prescriptionJson === "string" ? record.prescriptionJson : null;
  const provenanceRaw = typeof record.provenanceJson === "string" ? record.provenanceJson : null;
  if (record.prescriptionJson !== null && record.prescriptionJson !== undefined && prescriptionRaw === null) {
    issues.push("prescriptionJson は文字列である必要があります");
  }
  if (record.provenanceJson !== null && record.provenanceJson !== undefined && provenanceRaw === null) {
    issues.push("provenanceJson は文字列である必要があります");
  }

  let prescription: RunningPrescriptionValue | null = null;
  if (prescriptionRaw !== null) {
    const sizeIssue = jsonByteLimitIssue("prescriptionJson", prescriptionRaw, PRESCRIPTION_JSON_MAX_BYTES);
    if (sizeIssue) {
      issues.push(sizeIssue);
    } else {
      const parsed = parseJsonColumn(prescriptionRaw, runningPrescriptionSchema, { rejectHealthKeys: false });
      if (parsed.ok) prescription = parsed.value;
      else issues.push(...parsed.issues.map((i) => `prescriptionJson ${parsed.reason}: ${i}`));
    }
  }

  let provenance: Provenance | null = null;
  if (provenanceRaw !== null) {
    const sizeIssue = jsonByteLimitIssue("provenanceJson", provenanceRaw, PROVENANCE_JSON_MAX_BYTES);
    if (sizeIssue) {
      issues.push(sizeIssue);
    } else {
      const parsed = parseJsonColumn(provenanceRaw, provenanceSchema, { rejectHealthKeys: true });
      if (parsed.ok) provenance = parsed.value;
      else issues.push(...parsed.issues.map((i) => `provenanceJson ${parsed.reason}: ${i}`));
    }
  }

  if (prescription !== null) {
    if (mode === "WRITE" && prescription.loadSnapshot === undefined) {
      issues.push("prescriptionJson に loadSnapshot がありません（R9 以降の RUNNING_V2 保存では必須）");
    }
    const expected = projectRunningPrescription(prescription);
    for (const column of CONSISTENCY_COLUMNS) {
      if (!Object.is(record[column] ?? null, expected[column])) {
        issues.push(`${column} が prescriptionJson から導出される値と一致しません`);
      }
    }
    if (provenance !== null) issues.push(...provenancePrescriptionIssues(provenance, prescription));
  }

  if (issues.length > 0 || prescription === null || provenance === null) {
    throw new RunningPersistenceError(issues.length > 0 ? issues : ["prescriptionJson / provenanceJson を検証できません"]);
  }
  return { prescription, provenance };
}

/**
 * 入力（処方 JSON 文字列・provenance JSON 文字列・rationale・note）から保存レコードを作る。
 * 文字列は入力のまま保存し、列は処方から投影する。最後に `validateRunningMenuItemRecord` を必ず通す。
 */
export function buildRunningMenuItemRecord(input: RunningMenuItemPersistInput): ValidatedRunningMenuItem & { record: RunningMenuItemRecord } {
  if (typeof input.prescriptionJson !== "string") throw new RunningPersistenceError(["prescriptionJson は RUNNING_V2 で必須です"]);
  const sizeIssue = jsonByteLimitIssue("prescriptionJson", input.prescriptionJson, PRESCRIPTION_JSON_MAX_BYTES);
  if (sizeIssue) throw new RunningPersistenceError([sizeIssue]);
  const parsed = parseJsonColumn(input.prescriptionJson, runningPrescriptionSchema, { rejectHealthKeys: false });
  if (!parsed.ok) throw new RunningPersistenceError(parsed.issues.map((i) => `prescriptionJson ${parsed.reason}: ${i}`));

  const record: RunningMenuItemRecord = {
    ...projectRunningPrescription(parsed.value),
    note: input.note,
    prescriptionJson: input.prescriptionJson,
    provenanceJson: input.provenanceJson,
    rationale: input.rationale,
  };
  return { record, ...validateRunningMenuItemRecord(record, "WRITE") };
}
