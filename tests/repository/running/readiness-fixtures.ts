import { prisma } from "@/infra/db/prisma";
import { createRunningMenuItem } from "@/infra/repositories/running-item-repository";
import { addSessionItem, createSessionFromMenu } from "@/infra/repositories/session-repository";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { repLogEntrySchema } from "@/domain/running/monitoring/schema";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { ResolvedAgeBand } from "@/domain/running/context/ageBand";
import { makeMenuWithBlock, persistInputFor, planStride, planMvFly20, planSes, provenanceFor } from "./fixtures";

export async function makeReadinessSession(options: { prescriptions?: RunningPrescriptionValue[]; date?: string; ageBand?: ResolvedAgeBand; legacy?: boolean } = {}) {
  const { menu, block } = await makeMenuWithBlock();
  const prescriptions = options.prescriptions ?? [planStride(), planMvFly20(), planSes()];
  for (const prescription of prescriptions) {
    const provenance = provenanceFor(prescription);
    provenance.inputsDigest.ageBand = options.ageBand ?? "U15";
    await createRunningMenuItem(block.id, persistInputFor(prescription, { provenanceJson: JSON.stringify(provenance) }));
  }
  const session = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: options.date ?? "2026-09-20" }));
  if (options.legacy) await addSessionItem(session.id, { exerciseId: null, exerciseNameSnapshot: "従来種目", blockNameSnapshot: "追加" });
  return { menu, session, prescriptions, items: await itemsOf(session.id) };
}
export const itemsOf = (id: string) => prisma.sessionItem.findMany({ where: { trainingSessionId: id }, orderBy: { sortOrder: "asc" } });
export function validRepLog() {
  return repLogEntrySchema.parse({ stopPolicyId: "SP_ACC", setIndex: 1, repIndex: 1, timeS: null, timing: "UNKNOWN", effectiveTiming: "UNKNOWN",
    toleranceS: null, referenceTimeS: null, referenceSource: null, quality: "NOT_EVALUATED_COACH_ONLY", fasterThanTargetLower: null,
    startQuality: null, measuredVelocityDecrementPercent: null, action: "CONTINUE", safetyOutcome: "NONE", restTakenS: null,
    highSpeedExposureM: { lower: 0, upper: 0, unit: "m", source: "PLANNED", confidence: "LOW" }, reasons: [] });
}
