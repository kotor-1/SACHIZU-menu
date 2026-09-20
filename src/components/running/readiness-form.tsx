"use client";

import { useEffect, useId, useRef, useState } from "react";
import { evaluateSessionReadinessAction } from "@/actions/session-actions";
import {
  BODY_REGIONS,
  PAIN_STATUSES,
  RED_FLAGS,
  readinessReportSchema,
  type BodyRegion,
  type PainStatus,
  type RedFlag,
} from "@/domain/running/types/readiness";
import { Button, INPUT_CLASS } from "@/components/ui";
import { BODY_REGION_LABEL_JA, PAIN_STATUS_LABEL_JA, RED_FLAG_LABEL_JA } from "@/presentation/running/execution";

const REPORTER_LABELS = { ATHLETE: "選手", COACH: "コーチ", PARENT: "保護者" } as const;
const PERFORMANCE_LABELS = { NORMAL: "通常どおり", DOWN: "普段より低下", UNKNOWN: "未確認" } as const;
const SCORE_OPTIONS = [1, 2, 3, 4, 5] as const;

type ReadinessFormProps = {
  sessionId: string;
  busy: boolean;
  beginMutation: () => boolean;
  finishMutation: (refresh: boolean) => void;
};

export function ReadinessForm({ sessionId, busy, beginMutation, finishMutation }: ReadinessFormProps) {
  const privacyNoteId = useId();
  const resultId = useId();
  const painStatusName = useId();
  const [painStatus, setPainStatus] = useState<PainStatus>("NOT_ASKED");
  const [regions, setRegions] = useState<BodyRegion[]>([]);
  const [redFlags, setRedFlags] = useState<RedFlag[]>([]);
  const [soreness, setSoreness] = useState("");
  const [fatigue, setFatigue] = useState("");
  const [sleepQuality, setSleepQuality] = useState("");
  const [performanceStatus, setPerformanceStatus] = useState<keyof typeof PERFORMANCE_LABELS>("UNKNOWN");
  const [reporter, setReporter] = useState<keyof typeof REPORTER_LABELS>("COACH");
  const [reportedAtLocal, setReportedAtLocal] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const resultRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (message !== null) resultRef.current?.focus();
  }, [message]);

  function clearSensitiveState() {
    setPainStatus("NOT_ASKED");
    setRegions([]);
    setRedFlags([]);
    setSoreness("");
    setFatigue("");
    setSleepQuality("");
    setPerformanceStatus("UNKNOWN");
    setReporter("COACH");
    setReportedAtLocal("");
  }

  function toggleValue<T extends string>(values: T[], value: T, checked: boolean): T[] {
    return checked ? [...values, value] : values.filter((entry) => entry !== value);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!beginMutation()) return;
    setMessage(null);

    const score = (value: string) => (value === "" ? null : Number(value));
    const reportedAtDate = reportedAtLocal === "" ? null : new Date(reportedAtLocal);
    const parsed = readinessReportSchema.safeParse({
      pain: {
        status: painStatus,
        regions: painStatus === "PRESENT" ? regions : [],
        redFlags: painStatus === "PRESENT" ? redFlags : [],
      },
      soreness: score(soreness),
      fatigue: score(fatigue),
      sleepQuality: score(sleepQuality),
      performanceStatus,
      reporter,
      reportedAt: reportedAtDate !== null && !Number.isNaN(reportedAtDate.getTime())
        ? reportedAtDate.toISOString()
        : "",
    });
    if (!parsed.success) {
      setMessageTone("error");
      setMessage("入力内容を確認してください。選択項目に矛盾がある可能性があります。");
      finishMutation(false);
      return;
    }

    try {
      const result = await evaluateSessionReadinessAction({ sessionId, readinessReport: parsed.data });
      if (result.ok) {
        clearSensitiveState();
        setMessageTone("success");
        setMessage("当日の体調確認を保存しました。最新の実施状態を読み込みます。");
      } else {
        setMessageTone("error");
        setMessage(result.message);
      }
      finishMutation(true);
    } catch {
      setMessageTone("error");
      setMessage("送信を完了できませんでした。通信状態を確認して、もう一度お試しください。");
      finishMutation(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      autoComplete="off"
      className="min-w-0 space-y-4"
      aria-describedby={`${privacyNoteId}${message ? ` ${resultId}` : ""}`}
    >
      <fieldset disabled={busy} className="min-w-0 space-y-3 disabled:opacity-70">
        <legend className="text-sm font-semibold text-slate-800">実施前の体調確認</legend>
        <p id={privacyNoteId} className="text-xs leading-relaxed text-slate-500">
          回答は今回の判定にだけ使用し、画面やブラウザーには履歴として保存しません。
        </p>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-700">現在の痛み</legend>
          <div className="grid min-w-0 gap-2 sm:grid-cols-3 [&>*]:min-w-0">
            {PAIN_STATUSES.map((status) => (
              <label key={status} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name={painStatusName}
                  value={status}
                  checked={painStatus === status}
                  onChange={() => {
                    setPainStatus(status);
                    if (status !== "PRESENT") { setRegions([]); setRedFlags([]); }
                  }}
                />
                {PAIN_STATUS_LABEL_JA[status]}
              </label>
            ))}
          </div>
        </fieldset>

        {painStatus === "PRESENT" && (
          <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-slate-700">痛む部位（複数選択可）</legend>
              <div className="grid min-w-0 gap-1.5 sm:grid-cols-2 [&>*]:min-w-0">
                {BODY_REGIONS.map((region) => (
                  <label key={region} className="flex min-h-11 items-center gap-2 rounded-md bg-white px-3 py-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={regions.includes(region)}
                      onChange={(event) => setRegions(toggleValue(regions, region, event.target.checked))}
                    />
                    {BODY_REGION_LABEL_JA[region]}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-slate-700">該当するサイン（複数選択可）</legend>
              <div className="grid min-w-0 gap-1.5 sm:grid-cols-2 [&>*]:min-w-0">
                {RED_FLAGS.map((flag) => (
                  <label key={flag} className="flex min-h-11 items-center gap-2 rounded-md bg-white px-3 py-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={redFlags.includes(flag)}
                      onChange={(event) => setRedFlags(toggleValue(redFlags, flag, event.target.checked))}
                    />
                    {RED_FLAG_LABEL_JA[flag]}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        )}

        <div className="grid min-w-0 gap-3 sm:grid-cols-3 [&>*]:min-w-0">
          {([
            ["筋肉痛", soreness, setSoreness, "1（軽い）〜5（強い）"],
            ["疲労", fatigue, setFatigue, "1（軽い）〜5（強い）"],
            ["睡眠の質", sleepQuality, setSleepQuality, "1（低い）〜5（高い）"],
          ] as const).map(([label, value, setter, hint]) => (
            <label key={label} className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
              <select value={value} onChange={(event) => setter(event.target.value)} className={`${INPUT_CLASS} min-h-11`} aria-label={`${label} ${hint}`}>
                <option value="">未確認</option>
                {SCORE_OPTIONS.map((score) => <option key={score} value={score}>{score}</option>)}
              </select>
              <span className="mt-1 block text-xs text-slate-500">{hint}</span>
            </label>
          ))}
        </div>

        <div className="grid min-w-0 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">普段と比べたパフォーマンス</span>
            <select value={performanceStatus} onChange={(event) => setPerformanceStatus(event.target.value as keyof typeof PERFORMANCE_LABELS)} className={`${INPUT_CLASS} min-h-11`}>
              {Object.entries(PERFORMANCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">回答者</span>
            <select value={reporter} onChange={(event) => setReporter(event.target.value as keyof typeof REPORTER_LABELS)} className={`${INPUT_CLASS} min-h-11`}>
              {Object.entries(REPORTER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">回答日時</span>
            <input
              required
              type="datetime-local"
              value={reportedAtLocal}
              onChange={(event) => setReportedAtLocal(event.target.value)}
              className={`${INPUT_CLASS} min-h-11`}
            />
            <span className="mt-1 block text-xs text-slate-500">実際に体調を確認した日時を入力してください</span>
          </label>
        </div>
      </fieldset>

      <Button type="submit" size="lg" className="min-h-11 w-full sm:w-auto" disabled={busy}>
        {busy ? "送信中…" : "当日の体調を評価する"}
      </Button>
      {message && (
        <p id={resultId} ref={resultRef} tabIndex={-1} aria-live="polite" className={`rounded-lg px-3 py-2 text-sm outline-none ${messageTone === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-800"}`}>
          {message}
        </p>
      )}
    </form>
  );
}
