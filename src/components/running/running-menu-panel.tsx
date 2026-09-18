import { Card, CardBody, CardHeader } from "@/components/ui";
import type { RunningMenuView } from "@/actions/_running-menu-view";
import { FindingsList } from "./findings-list";
import { RunningContextEditor } from "./running-context-editor";

/**
 * メニュー画面の走トレーニング（Running v2）パネル（R10-B4B）。
 *
 * hooks を持たない表示コンポーネント（Server Component から描画できる）。状態を持つのは中の
 * `RunningContextEditor` だけ。集計は server が評価済みの DTO をそのまま出す（ここで計算しない）。
 */
export function RunningMenuPanel({ menuId, view }: { menuId: string; view: RunningMenuView }) {
  const { aggregation } = view;
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-bold text-slate-900">走トレーニング</h2>
        <p className="mt-0.5 text-xs text-slate-500">対象グループと計画日を設定すると、練習の型から処方を作れます。</p>
      </CardHeader>
      <CardBody className="space-y-5">
        <RunningContextEditor menuId={menuId} initial={view.context.draft} statusMessage={view.context.message} />

        <section className="min-w-0 space-y-2" aria-labelledby="running-menu-aggregation-heading">
          <h3 id="running-menu-aggregation-heading" className="text-sm font-semibold text-slate-900">
            このメニューの合計
          </h3>
          {aggregation.status === "NONE" && <p className="text-xs text-slate-500">走トレーニングの項目を追加すると、メニュー全体の合計を表示します。</p>}
          {aggregation.status === "NOT_EVALUATED" && (
            <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{aggregation.message}</p>
          )}
          {aggregation.status === "EVALUATED" && (
            <>
              <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {aggregation.totals.map((total) => (
                  <div key={total.label} className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 py-1">
                    <dt className="text-xs text-slate-600">{total.label}</dt>
                    <dd className="text-sm font-medium break-words text-slate-900">{total.valueLabel}</dd>
                  </div>
                ))}
              </dl>
              {aggregation.completenessNote !== null && <p className="text-xs text-slate-500">{aggregation.completenessNote}</p>}
              {aggregation.competitionDayNote !== null && <p className="text-xs text-slate-500">{aggregation.competitionDayNote}</p>}
              <FindingsList findings={aggregation.findings} idPrefix="running-menu-aggregation" heading="メニュー全体の確認事項" />
            </>
          )}
        </section>
      </CardBody>
    </Card>
  );
}
