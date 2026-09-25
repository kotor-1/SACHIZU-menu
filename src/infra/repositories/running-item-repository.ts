import type { MenuItem } from "@prisma/client";
import { prisma } from "@/infra/db/prisma";
import { parseJsonColumn, type JsonColumnInvalidReason } from "@/domain/running/persistence/jsonColumn";
import { runningMenuContextSchema, type RunningMenuContext } from "@/domain/running/persistence/menuContext";
import type { Provenance } from "@/domain/running/persistence/provenance";
import {
  RunningPersistenceError,
  buildRunningMenuItemRecord,
  validateRunningMenuItemRecord,
  type RunningMenuItemPersistInput,
} from "@/domain/running/persistence/runningItem";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";

/**
 * ============================================================================
 * Running Prescription Engine v2 — RUNNING_V2 MenuItem の保存・読込（§15.4・§19.2）
 * ============================================================================
 *
 * ここは domain が作った**完成済みの処方**を保存するだけ。plan() も RuleSet loader も呼ばない。
 *   - 書込み前に必ず `validateRunningMenuItemRecord` を通す（不正な入力は DB に書かない）
 *   - prescriptionJson / provenanceJson / rationale / runningContextJson は入力文字列をそのまま保存する
 *     （parse した値を stringify し直さない）
 *   - Session 側の planned 列を更新する API は作らない（§17.1 不変条件3）
 */

export { RunningPersistenceError };
export type { RunningMenuItemPersistInput };

export async function createRunningMenuItem(menuBlockId: string, input: RunningMenuItemPersistInput, serverItemId?: string) {
  const { record } = buildRunningMenuItemRecord(input);
  const max = await prisma.menuItem.aggregate({
    where: { menuBlockId },
    _max: { sortOrder: true },
  });
  return prisma.menuItem.create({
    data: { ...record, ...(serverItemId ? { id: serverItemId } : {}), menuBlockId, sortOrder: (max._max.sortOrder ?? -1) + 1 },
  });
}

/**
 * RUNNING_V2 項目の処方を置き換える（再計画・コーチ編集の結果を保存する primitive）。
 * provenance は呼び出し側が新しく作ったものだけを受け取り、ここで書き換えない。
 * LEGACY 項目を RUNNING_V2 に変換する用途には使わせない。
 */
export async function updateRunningMenuItem(id: string, input: RunningMenuItemPersistInput) {
  const { record } = buildRunningMenuItemRecord(input);
  const existing = await prisma.menuItem.findUnique({ where: { id }, select: { prescriptionKind: true } });
  if (!existing) throw new Error("項目が見つかりません");
  if (existing.prescriptionKind !== "RUNNING_V2") {
    throw new RunningPersistenceError(["RUNNING_V2 ではない項目を RUNNING_V2 の処方で上書きできません"]);
  }
  return prisma.menuItem.update({ where: { id }, data: record });
}

export type RunningMenuItemReadResult =
  | { status: "VALID"; item: MenuItem; prescription: RunningPrescriptionValue; provenance: Provenance }
  | { status: "INVALID"; item: MenuItem; issues: readonly string[] };

/**
 * RUNNING_V2 項目を読み、保存時と同じ規則で検証する（loadSnapshot の無い旧 snapshot は読込では許す）。
 * 保存済みの値が壊れていても例外にせず INVALID を返す。項目が無い・RUNNING_V2 ではない場合は null。
 */
export async function findRunningMenuItem(id: string): Promise<RunningMenuItemReadResult | null> {
  const item = await prisma.menuItem.findUnique({ where: { id } });
  if (!item || item.prescriptionKind !== "RUNNING_V2") return null;
  try {
    const { prescription, provenance } = validateRunningMenuItemRecord(item, "READ");
    return { status: "VALID", item, prescription, provenance };
  } catch (e) {
    if (e instanceof RunningPersistenceError) return { status: "INVALID", item, issues: e.issues };
    throw e;
  }
}

// --- MenuTemplate.runningContextJson ------------------------------------------

/** runningContextJson を検証して、入力文字列のまま保存する（null で削除）。 */
export async function saveMenuRunningContext(menuTemplateId: string, runningContextJson: string | null) {
  if (runningContextJson !== null) {
    const parsed = parseJsonColumn(runningContextJson, runningMenuContextSchema, { rejectHealthKeys: true });
    if (!parsed.ok) {
      throw new RunningPersistenceError(parsed.issues.map((i) => `runningContextJson ${parsed.reason}: ${i}`));
    }
  }
  return prisma.menuTemplate.update({ where: { id: menuTemplateId }, data: { runningContextJson } });
}

export type MenuRunningContextReadResult =
  | { status: "NONE" }
  | { status: "VALID"; context: RunningMenuContext; raw: string }
  | { status: "INVALID"; reason: JsonColumnInvalidReason; raw: string };

export async function findMenuRunningContext(menuTemplateId: string): Promise<MenuRunningContextReadResult | null> {
  const menu = await prisma.menuTemplate.findUnique({ where: { id: menuTemplateId }, select: { runningContextJson: true } });
  if (!menu) return null;
  const raw = menu.runningContextJson;
  if (raw === null) return { status: "NONE" };
  const parsed = parseJsonColumn(raw, runningMenuContextSchema, { rejectHealthKeys: true });
  return parsed.ok ? { status: "VALID", context: parsed.value, raw } : { status: "INVALID", reason: parsed.reason, raw };
}
