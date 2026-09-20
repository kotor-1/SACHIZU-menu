"use client";

import { useEffect, useId, useRef, useState } from "react";
import { recordRepAction, type RecordRepActionResult } from "@/actions/session-actions";
import { Button, INPUT_CLASS } from "@/components/ui";
import {
  TECHNIQUE_JUDGMENTS,
  repObservationSchema,
  type RepObservation,
} from "@/domain/running/monitoring/schema";
import { TIMING_METHODS, type TimingMethod } from "@/domain/running/types/intensity";
import { BODY_REGIONS, RED_FLAGS, type BodyRegion, type RedFlag } from "@/domain/running/types/readiness";
import { CONFIDENCES, type Confidence } from "@/domain/running/types/primitives";
import {
  BODY_REGION_LABEL_JA,
  RED_FLAG_LABEL_JA,
  START_QUALITY_LABEL_JA,
  TECHNIQUE_JUDGMENT_LABEL_JA,
} from "@/presentation/running/execution";
import { EXECUTION_CONFIDENCE_LABEL_JA, EXECUTION_TIMING_LABEL_JA } from "@/presentation/running/session-execution";
import { parseOptionalNumberInput, parseRequiredNumberInput } from "@/presentation/running/execution-input";

type RepLoggerProps = {
  sessionItemId: string;
  busy: boolean;
  beginMutation: () => boolean;
  finishMutation: (refresh: boolean) => void;
};

export function RepLogger({ sessionItemId, busy, beginMutation, finishMutation }: RepLoggerProps) {
  const helpId = useId();
  const resultId = useId();
  const [setIndex, setSetIndex] = useState("");
  const [repIndex, setRepIndex] = useState("");
  const [timing, setTiming] = useState<TimingMethod>("UNKNOWN");
  const [timeS, setTimeS] = useState("");
  const [videoFps, setVideoFps] = useState("");
  const [restTakenS, setRestTakenS] = useState("");
  const [measuredVelocityMps, setMeasuredVelocityMps] = useState("");
  const [velocityDecrement, setVelocityDecrement] = useState("");
  const [exposureLower, setExposureLower] = useState("");
  const [exposureUpper, setExposureUpper] = useState("");
  const [exposureConfidence, setExposureConfidence] = useState<Confidence>("HIGH");
  const [technique, setTechnique] = useState<"" | (typeof TECHNIQUE_JUDGMENTS)[number]>("");
  const [startQuality, setStartQuality] = useState<"" | keyof typeof START_QUALITY_LABEL_JA>("");
  const [environmentUnsafe, setEnvironmentUnsafe] = useState(false);
  const [effortBecameMaximal, setEffortBecameMaximal] = useState(false);
  const [hasAthleteReport, setHasAthleteReport] = useState(false);
  const [painNow, setPainNow] = useState(false);
  const [painRegion, setPainRegion] = useState<"" | BodyRegion>("");
  const [redFlags, setRedFlags] = useState<RedFlag[]>([]);
  const [requestsStop, setRequestsStop] = useState(false);
  const [result, setResult] = useState<RecordRepActionResult | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (result !== null) resultRef.current?.focus();
  }, [result]);

  function clearAfterSuccess() {
    setSetIndex("");
    setRepIndex("");
    setTimeS("");
    setVideoFps("");
    setRestTakenS("");
    setMeasuredVelocityMps("");
    setVelocityDecrement("");
    setExposureLower("");
    setExposureUpper("");
    setTechnique("");
    setStartQuality("");
    setEnvironmentUnsafe(false);
    setEffortBecameMaximal(false);
    setHasAthleteReport(false);
    setPainNow(false);
    setPainRegion("");
    setRedFlags([]);
    setRequestsStop(false);
    // 計時方法だけは反復入力で合理的に再利用でき、健康情報ではないため維持する。
  }

  function toggleFlag(flag: RedFlag, checked: boolean) {
    setRedFlags((current) => checked ? [...current, flag] : current.filter((entry) => entry !== flag));
  }

  function buildObservation(): unknown {
    const lower = parseOptionalNumberInput(exposureLower);
    const upper = parseOptionalNumberInput(exposureUpper);
    const coachJudgment = technique !== "" || startQuality !== "" || environmentUnsafe || effortBecameMaximal
      ? {
          ...(technique === "" ? {} : { technique }),
          ...(startQuality === "" ? {} : { startQuality }),
          ...(environmentUnsafe ? { environmentUnsafe: true } : {}),
          ...(effortBecameMaximal ? { effortBecameMaximal: true } : {}),
        }
      : null;
    const athleteReport = hasAthleteReport
      ? {
          painNow,
          ...(painNow && painRegion !== "" ? { painRegion } : {}),
          ...(painNow && redFlags.length > 0 ? { redFlags } : {}),
          ...(requestsStop ? { requestsStop: true } : {}),
        }
      : null;
    return {
      setIndex: parseRequiredNumberInput(setIndex),
      repIndex: parseRequiredNumberInput(repIndex),
      timeS: parseOptionalNumberInput(timeS),
      timing,
      ...(timing === "VIDEO" ? { videoFps: parseOptionalNumberInput(videoFps) } : {}),
      measuredVelocityMps: parseOptionalNumberInput(measuredVelocityMps),
      measuredVelocityDecrementPercent: parseOptionalNumberInput(velocityDecrement),
      actualHighSpeedExposureM: lower === null && upper === null ? null : {
        lower, upper, unit: "m", source: "MEASURED", confidence: exposureConfidence,
      },
      restTakenS: parseOptionalNumberInput(restTakenS),
      coachJudgment,
      athleteReport,
    };
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!beginMutation()) return;
    setResult(null);
    const parsed = repObservationSchema.safeParse(buildObservation());
    if (!parsed.success) {
      setResult({ ok: false, kind: "INVALID_INPUT", message: "入力内容を確認してください。必須項目または数値の形式が正しくありません。" });
      finishMutation(false);
      return;
    }
    try {
      const next = await recordRepAction({ sessionItemId, repObservation: parsed.data satisfies RepObservation });
      setResult(next);
      if (next.ok) clearAfterSuccess();
      finishMutation(true);
    } catch {
      setResult({ ok: false, kind: "REP_SAVE_FAILED", message: "送信を完了できませんでした。通信状態を確認して、もう一度お試しください。" });
      finishMutation(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      autoComplete="off"
      className="min-w-0 space-y-4"
      aria-describedby={`${helpId}${result ? ` ${resultId}` : ""}`}
    >
      <fieldset disabled={busy} className="min-w-0 space-y-3 disabled:opacity-70">
        <legend className="text-sm font-semibold text-slate-800">実施した1本を記録</legend>
        <p id={helpId} className="text-xs leading-relaxed text-slate-500">
          セット番号と本数は処方どおりに入力してください。順序の最終確認はサーバーで行います。
        </p>
        <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4 [&>*]:min-w-0">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">セット番号</span>
            <input required type="number" inputMode="numeric" min={1} step={1} value={setIndex} onChange={(event) => setSetIndex(event.target.value)} className={`${INPUT_CLASS} min-h-11`} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">本数</span>
            <input required type="number" inputMode="numeric" min={1} step={1} value={repIndex} onChange={(event) => setRepIndex(event.target.value)} className={`${INPUT_CLASS} min-h-11`} />
          </label>
          <label className="col-span-2 block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-700">計時方法</span>
            <select value={timing} onChange={(event) => setTiming(event.target.value as TimingMethod)} className={`${INPUT_CLASS} min-h-11`}>
              {TIMING_METHODS.map((method) => <option key={method} value={method}>{EXECUTION_TIMING_LABEL_JA[method]}</option>)}
            </select>
          </label>
        </div>

        <div className="grid min-w-0 gap-3 sm:grid-cols-3 [&>*]:min-w-0">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">タイム（秒）</span>
            <input type="number" inputMode="decimal" min="0" step="any" value={timeS} onChange={(event) => setTimeS(event.target.value)} placeholder="未計時なら空欄" className={`${INPUT_CLASS} min-h-11`} />
          </label>
          {timing === "VIDEO" && (
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">映像fps</span>
              <input type="number" inputMode="decimal" min="0" step="any" value={videoFps} onChange={(event) => setVideoFps(event.target.value)} placeholder="未入力可" className={`${INPUT_CLASS} min-h-11`} />
              <span className="mt-1 block text-xs text-slate-500">未入力時は自動推定しません</span>
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">実際の休息（秒）</span>
            <input type="number" inputMode="decimal" min="0" step="any" value={restTakenS} onChange={(event) => setRestTakenS(event.target.value)} placeholder="未入力可" className={`${INPUT_CLASS} min-h-11`} />
          </label>
        </div>

        <details className="rounded-lg border border-slate-200 bg-white p-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-slate-700 focus-visible:outline-2 focus-visible:outline-indigo-500">詳細入力</summary>
          <div className="mt-3 space-y-4">
            <div className="grid min-w-0 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
              <label className="block">
                <span className="mb-1 block text-sm text-slate-700">実測速度（m/s）</span>
                <input type="number" inputMode="decimal" min="0" step="any" value={measuredVelocityMps} onChange={(event) => setMeasuredVelocityMps(event.target.value)} className={`${INPUT_CLASS} min-h-11`} />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm text-slate-700">実測速度低下率（%）</span>
                <input type="number" inputMode="decimal" min="0" max="100" step="any" value={velocityDecrement} onChange={(event) => setVelocityDecrement(event.target.value)} className={`${INPUT_CLASS} min-h-11`} />
              </label>
            </div>

            <fieldset className="rounded-lg bg-slate-50 p-3">
              <legend className="px-1 text-sm font-medium text-slate-700">実測高速走行量（任意）</legend>
              <div className="grid min-w-0 gap-3 sm:grid-cols-3 [&>*]:min-w-0">
                <label className="block"><span className="mb-1 block text-xs text-slate-600">下限（m）</span><input type="number" inputMode="decimal" min="0" step="any" value={exposureLower} onChange={(event) => setExposureLower(event.target.value)} className={`${INPUT_CLASS} min-h-11`} /></label>
                <label className="block"><span className="mb-1 block text-xs text-slate-600">上限（m）</span><input type="number" inputMode="decimal" min="0" step="any" value={exposureUpper} onChange={(event) => setExposureUpper(event.target.value)} className={`${INPUT_CLASS} min-h-11`} /></label>
                <label className="block"><span className="mb-1 block text-xs text-slate-600">信頼度</span><select value={exposureConfidence} onChange={(event) => setExposureConfidence(event.target.value as Confidence)} className={`${INPUT_CLASS} min-h-11`}>{CONFIDENCES.map((value) => <option key={value} value={value}>{EXECUTION_CONFIDENCE_LABEL_JA[value]}</option>)}</select></label>
              </div>
            </fieldset>

            <fieldset className="rounded-lg bg-slate-50 p-3">
              <legend className="px-1 text-sm font-medium text-slate-700">コーチ判断（任意）</legend>
              <div className="grid min-w-0 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
                <label className="block"><span className="mb-1 block text-xs text-slate-600">動作</span><select value={technique} onChange={(event) => setTechnique(event.target.value as typeof technique)} className={`${INPUT_CLASS} min-h-11`}><option value="">未入力</option>{TECHNIQUE_JUDGMENTS.map((value) => <option key={value} value={value}>{TECHNIQUE_JUDGMENT_LABEL_JA[value]}</option>)}</select></label>
                <label className="block"><span className="mb-1 block text-xs text-slate-600">スタート品質</span><select value={startQuality} onChange={(event) => setStartQuality(event.target.value as typeof startQuality)} className={`${INPUT_CLASS} min-h-11`}><option value="">未入力</option>{Object.entries(START_QUALITY_LABEL_JA).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              </div>
              <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2 [&>*]:min-w-0">
                <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={environmentUnsafe} onChange={(event) => setEnvironmentUnsafe(event.target.checked)} />実施環境の安全性を確認できない</label>
                <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={effortBecameMaximal} onChange={(event) => setEffortBecameMaximal(event.target.checked)} />全力化したと判断</label>
              </div>
            </fieldset>

            <fieldset className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
              <legend className="px-1 text-sm font-medium text-slate-700">選手からの申告（今回の判定だけに使用）</legend>
              <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={hasAthleteReport} onChange={(event) => { setHasAthleteReport(event.target.checked); if (!event.target.checked) { setPainNow(false); setPainRegion(""); setRedFlags([]); setRequestsStop(false); } }} />申告を入力する
              </label>
              {hasAthleteReport && (
                <div className="mt-2 space-y-3">
                  <div className="grid min-w-0 gap-2 sm:grid-cols-2 [&>*]:min-w-0">
                    <label className="flex min-h-11 items-center gap-2 rounded-md bg-white px-3 text-sm text-slate-700"><input type="checkbox" checked={painNow} onChange={(event) => { setPainNow(event.target.checked); if (!event.target.checked) { setPainRegion(""); setRedFlags([]); } }} />現在痛みがある</label>
                    <label className="flex min-h-11 items-center gap-2 rounded-md bg-white px-3 text-sm font-medium text-rose-700"><input type="checkbox" checked={requestsStop} onChange={(event) => setRequestsStop(event.target.checked)} />選手が中止を希望</label>
                  </div>
                  {painNow && (
                    <>
                      <label className="block"><span className="mb-1 block text-xs text-slate-600">痛む部位</span><select value={painRegion} onChange={(event) => setPainRegion(event.target.value as typeof painRegion)} className={`${INPUT_CLASS} min-h-11`}><option value="">未選択</option>{BODY_REGIONS.map((value) => <option key={value} value={value}>{BODY_REGION_LABEL_JA[value]}</option>)}</select></label>
                      <fieldset className="min-w-0"><legend className="mb-1 text-xs text-slate-600">該当するサイン（複数選択可）</legend><div className="grid min-w-0 gap-1.5 sm:grid-cols-2 [&>*]:min-w-0">{RED_FLAGS.map((flag) => <label key={flag} className="flex min-h-11 items-center gap-2 rounded-md bg-white px-3 py-2 text-sm text-slate-700"><input type="checkbox" checked={redFlags.includes(flag)} onChange={(event) => toggleFlag(flag, event.target.checked)} />{RED_FLAG_LABEL_JA[flag]}</label>)}</div></fieldset>
                    </>
                  )}
                </div>
              )}
            </fieldset>
          </div>
        </details>
      </fieldset>

      <Button type="submit" size="lg" className="min-h-11 w-full sm:w-auto" disabled={busy}>
        {busy ? "記録中…" : "この1本を記録する"}
      </Button>

      {result && (
        <div id={resultId} ref={resultRef} tabIndex={-1} aria-live="polite" className={`rounded-lg p-3 text-sm outline-none ${result.ok ? "bg-emerald-50 text-emerald-900" : "bg-rose-50 text-rose-700"}`}>
          {result.ok ? (
            <div className="space-y-1">
              <p className="font-semibold">今回の判定：{result.data.monitor.actionLabel}</p>
              <p>品質：{result.data.monitor.qualityLabel}</p>
              <p>実施本数：{result.data.monitor.completedRepCount} / {result.data.monitor.plannedRepCount}</p>
              {result.data.monitor.nextRepRestS && (
                <p className="font-medium">今回の送信直後の追加指示：休息 {result.data.monitor.nextRepRestS.min}〜{result.data.monitor.nextRepRestS.max}秒</p>
              )}
              {result.data.monitor.reasons.length > 0 && <ul className="list-disc pl-5">{result.data.monitor.reasons.map((reason) => <li key={reason.code}>{reason.label}</li>)}</ul>}
            </div>
          ) : result.message}
        </div>
      )}
    </form>
  );
}
