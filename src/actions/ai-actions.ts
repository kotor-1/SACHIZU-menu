"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/infra/db/prisma";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { CURRENT_DRAFT_SCHEMA_VERSION, type ExerciseDraftPayload } from "@/domain/ai/draft-schema";

/**
 * 動作確認用のサンプル下書きを 1 件作る。
 *
 * Phase 1 では実際の解析を行わないが、
 * 「下書き → コーチが修正 → 種目として登録」という導線が
 * 本当に通っていることを確かめられるようにしておく。
 * Phase 2 では、ここが VideoAnalyzer の結果で置き換わるだけ。
 */
export async function createSampleDraftAction(): Promise<void> {
  const payload: ExerciseDraftPayload = {
    schemaVersion: CURRENT_DRAFT_SCHEMA_VERSION,
    name: "ミニハードル・クイックステップ",
    nameKana: "みにはーどるくいっくすてっぷ",
    description:
      "等間隔に並べたミニハードルの間を、1 歩ずつ素早く接地しながら通過する。接地時間の短縮を狙うドリル。",
    coachingPoint:
      "母指球で弾む。腰の位置を落とさず、上下動を抑えたまま脚だけを速く動かす。",
    commonMistake: "歩幅を合わせようとして減速し、接地が長くなる。",
    category: "DRILL",
    metricType: "DISTANCE",
    difficulty: 2,
    targets: ["COORDINATION", "TECHNIQUE", "ACCELERATION"],
    equipmentTags: ["ミニハードル"],
    generalTags: ["スプリントドリル"],
    defaultSets: 3,
    defaultDistanceMeters: 15,
    defaultRestSeconds: 60,
    observation:
      "選手は 10 台のミニハードルを 1 歩接地で通過。接地時間は概ね一定だが、後半 3 台で上体がやや後傾していた。",
  };

  await prisma.exerciseDraft.create({
    data: {
      ownerId: DEFAULT_OWNER_ID,
      payload: JSON.stringify(payload),
      confidence: 0.72,
      status: "PENDING_REVIEW",
    },
  });

  revalidatePath("/ai");
}

export async function rejectDraftAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await prisma.exerciseDraft.update({ where: { id }, data: { status: "REJECTED" } });
  revalidatePath("/ai");
}

export async function deleteDraftAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await prisma.exerciseDraft.delete({ where: { id } });
  revalidatePath("/ai");
}
