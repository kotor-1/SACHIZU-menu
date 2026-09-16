/**
 * 責務分離の検証:
 *   テンプレートを後から編集しても、作成済みセッションが変わらないこと。
 *   種目を削除しても、セッション記録に名前が残ること。
 */
import { PrismaClient } from "@prisma/client";
import { prisma as appPrisma } from "@/infra/db/prisma";
import { createRunningMenuItem } from "@/infra/repositories/running-item-repository";
import { createSessionFromMenu } from "@/infra/repositories/session-repository";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { planRunningPrescription, type PlanRequest } from "@/domain/running/planning";
import { buildProvenance } from "@/domain/running/persistence/provenance";
import { renderRationaleJa } from "@/domain/running/rationale/render-ja";
import { createCoachActor } from "@/domain/running/types/actor";
const prisma = new PrismaClient();

const ok = (label: string, cond: boolean, detail = "") =>
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);

async function main() {
  // 準備
  const ex = await prisma.exercise.create({
    data: { name: "検証用ドリル", category: "DRILL", metricType: "DISTANCE" },
  });

  const menu = await prisma.menuTemplate.create({
    data: {
      name: "検証用メニュー",
      blocks: {
        create: {
          name: "主運動",
          sortOrder: 0,
          items: { create: { exerciseId: ex.id, sortOrder: 0, sets: 3, distanceMeters: 60 } },
        },
      },
    },
    include: { blocks: { include: { items: true } } },
  });
  const item = menu.blocks[0].items[0];

  // セッションを展開（本番と同じロジックを写す）
  const src = await prisma.menuTemplate.findUniqueOrThrow({
    where: { id: menu.id },
    include: {
      blocks: {
        orderBy: { sortOrder: "asc" },
        include: { items: { orderBy: { sortOrder: "asc" }, include: { exercise: true } } },
      },
    },
  });
  let n = 0;
  const session = await prisma.trainingSession.create({
    data: {
      title: "検証セッション",
      date: new Date(),
      sourceMenuTemplateId: src.id,
      sourceMenuNameSnapshot: src.name,
      items: {
        create: src.blocks.flatMap((b) =>
          b.items.map((it) => ({
            exerciseId: it.exerciseId,
            exerciseNameSnapshot: it.exercise?.name ?? "(未設定)",
            blockNameSnapshot: b.name,
            sortOrder: n++,
            plannedSets: it.sets,
            plannedDistanceMeters: it.distanceMeters,
          })),
        ),
      },
    },
    include: { items: true },
  });

  ok("展開時に計画値がコピーされる",
     session.items[0].plannedSets === 3 && session.items[0].plannedDistanceMeters === 60,
     `sets=${session.items[0].plannedSets}, dist=${session.items[0].plannedDistanceMeters}`);

  // --- テンプレートを後から変更する ---
  await prisma.menuItem.update({ where: { id: item.id }, data: { sets: 8, distanceMeters: 150 } });
  await prisma.exercise.update({ where: { id: ex.id }, data: { name: "名前を変えたドリル" } });
  await prisma.menuBlock.update({ where: { id: menu.blocks[0].id }, data: { name: "変更後ブロック" } });

  const after = await prisma.trainingSession.findUniqueOrThrow({
    where: { id: session.id },
    include: { items: true },
  });

  ok("テンプレートの負荷変更がセッションに波及しない",
     after.items[0].plannedSets === 3 && after.items[0].plannedDistanceMeters === 60,
     `sets=${after.items[0].plannedSets}, dist=${after.items[0].plannedDistanceMeters}`);
  ok("種目名の変更がセッション記録に波及しない",
     after.items[0].exerciseNameSnapshot === "検証用ドリル",
     after.items[0].exerciseNameSnapshot);
  ok("ブロック名の変更がセッション記録に波及しない",
     after.items[0].blockNameSnapshot === "主運動",
     after.items[0].blockNameSnapshot);

  // --- 種目を削除する ---
  await prisma.exercise.delete({ where: { id: ex.id } });
  const afterDelete = await prisma.trainingSession.findUniqueOrThrow({
    where: { id: session.id },
    include: { items: true },
  });
  ok("種目を削除しても記録は残る（参照だけ null になる）",
     afterDelete.items.length === 1 &&
       afterDelete.items[0].exerciseId === null &&
       afterDelete.items[0].exerciseNameSnapshot === "検証用ドリル");

  const menuAfterDelete = await prisma.menuTemplate.findUniqueOrThrow({
    where: { id: menu.id },
    include: { blocks: { include: { items: true } } },
  });
  ok("種目を削除してもメニューの項目自体は残る",
     menuAfterDelete.blocks[0].items.length === 1 &&
       menuAfterDelete.blocks[0].items[0].exerciseId === null);

  // --- メニューを削除する ---
  await prisma.menuTemplate.delete({ where: { id: menu.id } });
  const afterMenuDelete = await prisma.trainingSession.findUniqueOrThrow({
    where: { id: session.id },
    include: { items: true },
  });
  ok("メニューを削除しても練習記録は消えない",
     afterMenuDelete.items.length === 1 &&
       afterMenuDelete.sourceMenuTemplateId === null &&
       afterMenuDelete.sourceMenuNameSnapshot === "検証用メニュー");

  // 後片付け
  await prisma.trainingSession.delete({ where: { id: session.id } });

  await verifyRunningV2Snapshot();
  await prisma.$disconnect();
}

/** MenuItem 列 → SessionItem 列（正式仕様 §17.2 の v2 追加分）。 */
const V2_COPY_COLUMNS = [
  ["prescriptionKind", "prescriptionKind"],
  ["runningMethod", "runningMethod"],
  ["sessionTemplateId", "sessionTemplateId"],
  ["recoveryStructure", "recoveryStructure"],
  ["buildUpDistanceMeters", "plannedBuildUpDistanceMeters"],
  ["flyZoneDistanceMeters", "plannedFlyZoneDistanceMeters"],
  ["setRestSeconds", "plannedSetRestSeconds"],
  ["intraRepRestSeconds", "plannedIntraRepRestSeconds"],
  ["intensityReferenceKind", "plannedIntensityReferenceKind"],
  ["prescriptionConfidence", "plannedPrescriptionConfidence"],
  ["ruleSetVersion", "ruleSetVersion"],
  ["ruleSetContentHash", "ruleSetContentHash"],
  ["prescriptionJson", "plannedPrescriptionJson"],
  ["provenanceJson", "plannedProvenanceJson"],
  ["rationale", "plannedRationale"],
] as const;

/**
 * Running v2（R9）: 本番の createRunningMenuItem() / createSessionFromMenu() を呼んで検証する
 * （コピー処理をこのスクリプトに再実装しない）。作成した行は最後に削除する。
 */
async function verifyRunningV2Snapshot() {
  const plan = planRunningPrescription({
    planningDate: "2026-09-15",
    selection: { method: "STRIDE", templateId: "ST_RELAXED" },
    subject: {
      kind: "ATHLETE",
      profile: {
        birthDate: "1998-01-01",
        primaryEvent: "400m",
        maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: "2026-09-01" },
        trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
        marks: [],
        vmax: null,
        allowAdvancedMethods: true,
      },
    },
    menuContext: { phase: null, plannedDate: null, plannedAt: null, competitions: [], otherItems: [], availableMinutes: null },
    history: null,
    readiness: null,
    positionPreference: null,
    coachEdits: [],
    overrides: [],
    coachReference: null,
    actor: createCoachActor("verify-snapshot"),
  } as unknown as PlanRequest);
  if (plan.status !== "OK") throw new Error(`検証用の処方を作れません: ${plan.status}`);
  const p = plan.prescription;

  const menu = await prisma.menuTemplate.create({
    data: { name: "検証用メニュー（v2）", blocks: { create: { name: "主運動", sortOrder: 0 } } },
    include: { blocks: true },
  });
  let sessionId: string | null = null;
  try {
    const item = await createRunningMenuItem(menu.blocks[0].id, {
      prescriptionJson: JSON.stringify(p, null, 2),
      provenanceJson: JSON.stringify(
        buildProvenance({
          prescription: p,
          engineVersion: "verify-snapshot",
          inputsDigest: {
            tier: p.tier,
            ageBand: "ADULT",
            maturityEffective: "POST",
            trainingAgeTier: "ADVANCED",
            phase: null,
            plannedDate: null,
            competitionWindows: [],
            referenceKinds: [p.intensity.reference.kind],
            historyCoverage72h: "NONE",
            readinessActions: [],
          },
          coachEdits: [],
          overrides: [],
          aiReason: null,
        }),
      ),
      rationale: renderRationaleJa(p.rationale).join("\n"),
      note: null,
    });
    const session = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-20" }));
    sessionId = session.id;
    const copied = await prisma.sessionItem.findFirstOrThrow({ where: { trainingSessionId: session.id } });

    const mismatched: string[] = V2_COPY_COLUMNS.filter(([from, to]) => copied[to] !== item[from]).map(([from]) => from);
    // v2 の loadCategory は plan 時点の loadSnapshot から（RuleSet を読まない）
    if (copied.loadCategory !== p.loadSnapshot?.weeklyLoadCategory) mismatched.push("loadCategory");
    ok("v2 の計画列と JSON・理由文が文字列のままコピーされる",
       mismatched.length === 0 &&
         copied.prescriptionKind === "RUNNING_V2" &&
         copied.plannedPrescriptionJson === item.prescriptionJson &&
         copied.plannedProvenanceJson === item.provenanceJson &&
         copied.plannedRationale === item.rationale,
       mismatched.length === 0 ? `${copied.runningMethod} / ${copied.ruleSetVersion}` : `不一致: ${mismatched.join(", ")}`);

    // --- MenuItem の v2 JSON を後から編集する ---
    await prisma.menuItem.update({
      where: { id: item.id },
      data: { prescriptionJson: '{"edited":true}', provenanceJson: "{}", rationale: "変更後の理由文", ruleSetVersion: "edited", sets: 9 },
    });
    const afterEdit = await prisma.sessionItem.findUniqueOrThrow({ where: { id: copied.id } });
    ok("MenuItem の v2 JSON を編集してもセッション記録に波及しない",
       JSON.stringify(afterEdit) === JSON.stringify(copied),
       afterEdit.ruleSetVersion ?? "");
  } finally {
    if (sessionId) await prisma.trainingSession.delete({ where: { id: sessionId } });
    await prisma.menuTemplate.delete({ where: { id: menu.id } });
    await appPrisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
