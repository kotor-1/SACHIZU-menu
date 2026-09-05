import Link from "next/link";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LinkButton,
  PageHeader,
} from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import {
  createSampleDraftAction,
  deleteDraftAction,
  rejectDraftAction,
} from "@/actions/ai-actions";
import { getVideoAnalyzer } from "@/domain/ai/analyzer";
import {
  DRAFT_STATUS_LABEL,
  parseDraftPayload,
  type DraftStatus,
} from "@/domain/ai/draft-schema";
import { EXERCISE_CATEGORY_LABEL, type ExerciseCategory } from "@/domain/exercise/constants";
import { prisma } from "@/infra/db/prisma";

/** DB を直接読むため、ビルド時に固定せず毎回サーバーで描画する。 */
export const dynamic = "force-dynamic";


export const metadata = { title: "動画解析｜SACHIZU" };

const PIPELINE = [
  { step: "動画を登録", table: "VideoAsset", ready: true },
  { step: "解析ジョブを実行", table: "AnalysisJob", ready: false },
  { step: "AIが種目を下書き", table: "ExerciseDraft", ready: false },
  { step: "コーチが修正", table: "種目登録フォーム", ready: true },
  { step: "種目として登録", table: "Exercise", ready: true },
];

export default async function AiPage() {
  const analyzer = getVideoAnalyzer();
  const available = analyzer.isAvailable();

  const drafts = await prisma.exerciseDraft.findMany({
    where: { status: { not: "REJECTED" } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return (
    <>
      <PageHeader
        title="動画解析（AI下書き）"
        description="ドリル動画から種目情報を下書きする機能です。Phase 1 では解析エンジンは未接続です。"
      />

      <Card className={available ? "mb-4 border-emerald-200" : "mb-4 border-amber-200"}>
        <CardBody className="flex flex-wrap items-center gap-3">
          <Badge
            className={
              available
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-amber-200 bg-amber-50 text-amber-700"
            }
          >
            {available ? "解析エンジン：接続済み" : "解析エンジン：未接続"}
          </Badge>
          <p className="text-sm text-slate-600">
            {available
              ? `${analyzer.provider} / ${analyzer.model} を使用します。`
              : "Phase 2 で Qwen などの Vision Language Model を接続します。下書きの確認・登録までの流れは今から使えます。"}
          </p>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">
              AI下書き（{drafts.filter((d) => d.status === "PENDING_REVIEW").length} 件が確認待ち）
            </h2>
            <form action={createSampleDraftAction}>
              <SubmitButton variant="secondary" size="sm">
                サンプル下書きを作る
              </SubmitButton>
            </form>
          </div>

          {drafts.length === 0 ? (
            <EmptyState
              title="下書きはまだありません"
              description="Phase 2 で動画を解析すると、ここに種目の下書きが並びます。今は「サンプル下書きを作る」で導線を確認できます。"
            />
          ) : (
            <ul className="space-y-3">
              {drafts.map((draft) => {
                const payload = parseDraftPayload(draft.payload);
                const applied = draft.status === "APPLIED";
                return (
                  <li key={draft.id}>
                    <Card>
                      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge
                            className={
                              applied
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : "border-amber-200 bg-amber-50 text-amber-700"
                            }
                          >
                            {DRAFT_STATUS_LABEL[draft.status as DraftStatus] ?? draft.status}
                          </Badge>
                          {draft.confidence != null && (
                            <span className="text-xs text-slate-400">
                              確信度 {Math.round(draft.confidence * 100)}%
                            </span>
                          )}
                        </div>
                        <div className="flex gap-1.5">
                          {!applied && (
                            <LinkButton
                              href={`/exercises/new?draft=${draft.id}`}
                              size="sm"
                            >
                              確認して登録
                            </LinkButton>
                          )}
                          <form action={rejectDraftAction}>
                            <input type="hidden" name="id" value={draft.id} />
                            <SubmitButton variant="secondary" size="sm">
                              却下
                            </SubmitButton>
                          </form>
                          <form action={deleteDraftAction}>
                            <input type="hidden" name="id" value={draft.id} />
                            <ConfirmSubmitButton message="この下書きを削除します。よろしいですか？">
                              削除
                            </ConfirmSubmitButton>
                          </form>
                        </div>
                      </CardHeader>
                      <CardBody className="space-y-2">
                        <h3 className="text-base font-semibold text-slate-900">
                          {payload.name ?? "（名称なし）"}
                        </h3>
                        <div className="flex flex-wrap gap-1.5 text-xs text-slate-500">
                          {payload.category && (
                            <Badge>
                              {EXERCISE_CATEGORY_LABEL[payload.category as ExerciseCategory] ??
                                payload.category}
                            </Badge>
                          )}
                          {(payload.equipmentTags ?? []).map((t) => (
                            <Badge key={t}>{t}</Badge>
                          ))}
                        </div>
                        {payload.description && (
                          <p className="text-sm text-slate-600">{payload.description}</p>
                        )}
                        {payload.observation && (
                          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                            <span className="font-medium">AIが動画から読み取った内容：</span>
                            {payload.observation}
                          </p>
                        )}
                      </CardBody>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <h2 className="text-sm font-semibold text-slate-700">処理の流れ</h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Phase 1 で用意済みの箇所と、Phase 2 で足す箇所
              </p>
            </CardHeader>
            <CardBody>
              <ol className="space-y-2.5">
                {PIPELINE.map((p, i) => (
                  <li key={p.step} className="flex gap-2.5">
                    <span
                      className={
                        "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold " +
                        (p.ready
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-slate-100 text-slate-400")
                      }
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm text-slate-700">{p.step}</p>
                      <p className="text-xs text-slate-400">
                        {p.table}
                        {p.ready ? "（実装済み）" : "（Phase 2）"}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-sm font-semibold text-slate-700">拡張のしかた</h2>
            </CardHeader>
            <CardBody className="space-y-2 text-xs leading-relaxed text-slate-600">
              <p>
                解析処理は <code className="rounded bg-slate-100 px-1">VideoAnalyzer</code>{" "}
                インターフェース 1 つに閉じています。
              </p>
              <ol className="ml-4 list-decimal space-y-1">
                <li>
                  <code className="rounded bg-slate-100 px-1">
                    src/infra/ai/qwen-analyzer.ts
                  </code>{" "}
                  を実装
                </li>
                <li>
                  <code className="rounded bg-slate-100 px-1">
                    src/domain/ai/analyzer.ts
                  </code>{" "}
                  の返り値を差し替え
                </li>
              </ol>
              <p>
                DB（VideoAsset / AnalysisJob / ExerciseDraft）と、
                下書きを読み込む登録フォームは Phase 1 で完成しているため、
                スキーマ変更も画面の作り直しも発生しません。
              </p>
              <p className="pt-1">
                <Link href="/exercises/new" className="text-indigo-600 hover:underline">
                  種目の手動登録はこちら
                </Link>
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
