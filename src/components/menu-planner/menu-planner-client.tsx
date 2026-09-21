"use client";

import { useRef, useState } from "react";

import {
  generateMenuPlannerAction,
  reviseMenuPlannerAction,
  saveMenuPlannerAction,
} from "@/actions/menu-planner-actions";
import {
  createMenuPlannerOperationCoordinator,
  type MenuPlannerOperationCoordinator,
} from "@/components/menu-planner/operation-coordinator";
import type { AiClarificationQuestion } from "@/domain/menu-planner";
import type { MenuPlannerPreview } from "@/presentation/menu-planner/preview";
import { Badge, Button, Card, CardBody, CardHeader, Field, INPUT_CLASS } from "@/components/ui";

type ContextMenuOption = {
  id: string;
  name: string;
};

type Phase =
  | "IDLE"
  | "GENERATING"
  | "CLARIFICATION"
  | "PREVIEW"
  | "REVISING"
  | "SAVING"
  | "SAVED"
  | "ERROR";

type ClarificationSource = "GENERATE" | "REVISION";

type PreviewItem = MenuPlannerPreview["blocks"][number]["items"][number];
type LegacyDose = Extract<NonNullable<PreviewItem["dose"]>, { kind: "LEGACY" }>;

const EMPTY_CONSTRAINTS = {
  phase: null,
  targetEvents: [],
  purposes: [],
  availableMinutes: null,
  equipment: null,
  preferredExerciseIds: [],
  excludedExerciseIds: [],
} as const;

const ERROR_MESSAGES: Record<string, string> = {
  FEATURE_DISABLED: "この機能は現在準備中です。しばらくお待ちください。",
  INVALID_INPUT: "入力内容を確認してください。",
  AI_PROVIDER_UNAVAILABLE: "提案サービスを利用できません。時間をおいて再度お試しください。",
  AI_PROVIDER_FAILED: "提案を作成できませんでした。入力を見直して再度お試しください。",
  AI_OUTPUT_INVALID: "提案の内容を確認できませんでした。別の表現で再度お試しください。",
  STALE_PREVIEW: "このプレビューは現在のメニュー状態と一致しなくなりました。もう一度作成してください。",
  PLANNING_REJECTED: "この内容ではプレビューを作成できませんでした。条件を見直してください。",
  SAVE_FAILED: "メニューを保存できませんでした。内容を確認して再度お試しください。",
};

const ITEM_STATE_LABEL: Record<MenuPlannerPreview["blocks"][number]["items"][number]["state"], string> = {
  READY: "準備完了",
  MANUAL_INPUT_REQUIRED: "確認が必要",
  REJECTED: "作成不可",
};

const ITEM_KIND_LABEL = {
  EXERCISE: "種目",
  RUNNING: "走りのメニュー",
} as const;

function messageForError(error: { kind: string }): string {
  return ERROR_MESSAGES[error.kind] ?? "処理を完了できませんでした。時間をおいて再度お試しください。";
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
      {message}
    </div>
  );
}

function DetailList({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-sm text-slate-600">
      {items.map((item, index) => <li key={`${item}-${index}`}>・{item}</li>)}
    </ul>
  );
}

function LegacyDose({
  prescription,
  setRestSeconds,
}: {
  prescription: LegacyDose["prescription"];
  setRestSeconds: number | null;
}) {
  const values = [
    prescription.sets === null ? null : `セット数 ${prescription.sets}`,
    prescription.reps === null ? null : `回数 ${prescription.reps}`,
    prescription.distanceMeters === null ? null : `距離 ${prescription.distanceMeters}m`,
    prescription.durationSeconds === null ? null : `時間 ${prescription.durationSeconds}秒`,
    prescription.restSeconds === null ? null : `レスト ${prescription.restSeconds}秒`,
    prescription.intensityPercent === null ? null : `強度 ${prescription.intensityPercent}%`,
    prescription.loadKg === null ? null : `負荷 ${prescription.loadKg}kg`,
    setRestSeconds === null ? null : `セット間 ${setRestSeconds}秒`,
  ].filter((value): value is string => value !== null);

  return <DetailList items={values} />;
}

function DoseSummary({
  dose,
}: {
  dose: MenuPlannerPreview["blocks"][number]["items"][number]["dose"];
}) {
  if (dose === null) return null;

  if (dose.kind === "LEGACY") {
    return <LegacyDose prescription={dose.prescription} setRestSeconds={dose.setRestSeconds} />;
  }

  const labels = [
    dose.dose.countsLabel,
    dose.dose.distanceLabel,
    dose.dose.durationLabel,
    dose.dose.restLabel,
    dose.dose.setRestLabel,
    dose.dose.intraRepRestLabel,
    dose.dose.intensityLabel,
    dose.dose.intensityTargetLabel,
    dose.dose.restFeasibilityLabel,
    dose.dose.coachTargetSplit === null
      ? null
      : `${dose.dose.coachTargetSplit.heading}：${dose.dose.coachTargetSplit.segments
        .map((segment) => `${segment.distanceLabel} ${segment.targetTimeLabel}`)
        .join("、")}`,
    dose.confidence.prescriptionLabel,
    dose.confidence.directnessLabel,
    dose.confidence.inputDataLabel,
    dose.confidence.ruleSetNoticeLabel,
  ].filter((value): value is string => value !== null);

  return <DetailList items={labels} />;
}

function PreviewItem({ item }: { item: PreviewItem }) {
  const findingMessages = item.findings.flatMap((finding) => [
    finding.message,
    finding.severityLabels.join("・"),
    finding.severityNote,
    ...finding.details.flatMap((detail) => [detail.subjectLabel, detail.valueLabel, detail.limitLabel]),
  ]).filter((value): value is string => value !== null);
  const reasons = [item.aiReason, ...item.engineRationale, ...item.warnings, ...item.eligibilityReasons.map((reason) => reason.message)]
    .filter((value): value is string => value !== null);

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap gap-1.5">
            <Badge className="border-indigo-200 bg-indigo-50 text-indigo-700">
              {ITEM_KIND_LABEL[item.selection.kind]}
            </Badge>
            <Badge className={item.state === "READY" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
              {ITEM_STATE_LABEL[item.state]}
            </Badge>
          </div>
          <h4 className="break-words text-base font-semibold text-slate-900">{item.title}</h4>
        </div>
      </div>

      <DoseSummary dose={item.dose} />
      <DetailList items={reasons} />
      <DetailList items={findingMessages} />

      {item.substitutes.some((substitute) => substitute.label !== null) && (
        <p className="mt-3 text-sm text-slate-600">
          代替候補：{item.substitutes
            .map((substitute) => substitute.label)
            .filter((label): label is string => label !== null)
            .join("、")}
        </p>
      )}
    </li>
  );
}

function PreviewCard({ preview }: { preview: MenuPlannerPreview }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs font-medium text-slate-400">作成したプレビュー</p>
            <h2 className="mt-1 text-lg font-bold text-slate-900">{preview.menuName}</h2>
          </div>
          <Badge className="border-slate-200 bg-slate-100 text-slate-700">保存前の下書き</Badge>
        </div>
      </CardHeader>
      <CardBody className="space-y-5">
        {preview.blocks.map((block) => (
          <section key={block.blockKey} aria-labelledby={`planner-block-${block.blockKey}`}>
            <h3 id={`planner-block-${block.blockKey}`} className="mb-2 text-sm font-semibold text-slate-700">
              {block.title}
            </h3>
            <ul className="space-y-3">
              {block.items.map((item) => <PreviewItem key={item.itemKey} item={item} />)}
            </ul>
          </section>
        ))}

        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          所要時間の目安：{preview.estimatedTime.seconds === null ? "不明" : `${preview.estimatedTime.seconds}秒`}
        </div>

        {!preview.canSave && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            一部確認が必要なため、このプレビューは保存できません。
          </p>
        )}
      </CardBody>
    </Card>
  );
}

export function MenuPlannerClient({ contextMenus }: { contextMenus: readonly ContextMenuOption[] }) {
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [menuName, setMenuName] = useState("");
  const [contextMenuTemplateId, setContextMenuTemplateId] = useState(contextMenus[0]?.id ?? "");
  const [requestText, setRequestText] = useState("");
  const [revisionText, setRevisionText] = useState("");
  const [clarificationAnswer, setClarificationAnswer] = useState("");
  const [clarification, setClarification] = useState<AiClarificationQuestion | null>(null);
  const [clarificationSource, setClarificationSource] = useState<ClarificationSource>("GENERATE");
  const [preview, setPreview] = useState<MenuPlannerPreview | null>(null);
  const [acceptToken, setAcceptToken] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedMenuId, setSavedMenuId] = useState<string | null>(null);
  const operationCoordinatorRef = useRef<MenuPlannerOperationCoordinator | null>(null);

  const getOperationCoordinator = () => {
    if (operationCoordinatorRef.current === null) {
      operationCoordinatorRef.current = createMenuPlannerOperationCoordinator();
    }
    return operationCoordinatorRef.current;
  };

  const busy = phase === "GENERATING" || phase === "REVISING" || phase === "SAVING";
  const showPreview = preview !== null && phase !== "CLARIFICATION";

  const clearLineage = () => {
    setPreview(null);
    setAcceptToken(null);
    setClarification(null);
    setSavedMenuId(null);
  };

  const submitGenerate = async (nextRequestText: string) => {
    const coordinator = getOperationCoordinator();
    if (coordinator.isInFlight()) return;
    const normalizedRequest = nextRequestText.trim();
    const normalizedMenuName = menuName.trim();
    const selectedContextMenuTemplateId = contextMenuTemplateId;
    if (normalizedRequest.length === 0 || normalizedMenuName.length === 0 || selectedContextMenuTemplateId.length === 0) {
      setErrorMessage("メニュー名・参照メニュー・希望内容を入力してください。");
      setPhase("ERROR");
      return;
    }
    const generation = coordinator.begin();
    if (generation === null) return;

    setPhase("GENERATING");
    setErrorMessage(null);
    clearLineage();
    setRevisionText("");
    try {
      const result = await generateMenuPlannerAction({
        schemaVersion: 1,
        contextMenuTemplateId: selectedContextMenuTemplateId,
        menuName: normalizedMenuName,
        coachRequest: {
          schemaVersion: 1,
          requestText: normalizedRequest,
          constraints: EMPTY_CONSTRAINTS,
        },
      });

      if (!coordinator.isCurrent(generation)) return;
      if (!result.ok) {
        setErrorMessage(messageForError(result.error));
        setPhase("ERROR");
        return;
      }
      if (result.result.kind === "CLARIFICATION") {
        setClarification(result.result.question);
        setClarificationSource("GENERATE");
        setClarificationAnswer("");
        setPhase("CLARIFICATION");
        return;
      }
      setRequestText(normalizedRequest);
      setPreview(result.result.preview);
      setAcceptToken(result.result.acceptToken);
      setPhase("PREVIEW");
    } catch {
      if (!coordinator.isCurrent(generation)) return;
      setErrorMessage("処理を完了できませんでした。時間をおいて再度お試しください。");
      setPhase("ERROR");
    } finally {
      coordinator.finish(generation);
    }
  };

  const submitRevision = async (nextRevisionText: string) => {
    const coordinator = getOperationCoordinator();
    if (coordinator.isInFlight()) return;
    const normalizedRevision = nextRevisionText.trim();
    const currentToken = acceptToken;
    if (currentToken === null || normalizedRevision.length === 0) {
      setErrorMessage("修正内容を入力してください。");
      setPhase(preview === null ? "ERROR" : "PREVIEW");
      return;
    }
    const generation = coordinator.begin();
    if (generation === null) return;

    setPhase("REVISING");
    setErrorMessage(null);
    setClarification(null);
    try {
      const result = await reviseMenuPlannerAction({
        schemaVersion: 1,
        acceptToken: currentToken,
        revisionText: normalizedRevision,
      });

      if (!coordinator.isCurrent(generation)) return;
      if (!result.ok) {
        if (result.error.kind === "STALE_PREVIEW") {
          clearLineage();
          setErrorMessage(messageForError(result.error));
          setPhase("ERROR");
        } else {
          setErrorMessage(messageForError(result.error));
          setPhase(preview === null ? "ERROR" : "PREVIEW");
        }
        return;
      }
      if (result.result.kind === "CLARIFICATION") {
        setClarification(result.result.question);
        setClarificationSource("REVISION");
        setClarificationAnswer("");
        setPhase("CLARIFICATION");
        return;
      }
      setPreview(result.result.preview);
      setAcceptToken(result.result.acceptToken);
      setRevisionText("");
      setPhase("PREVIEW");
    } catch {
      if (!coordinator.isCurrent(generation)) return;
      setErrorMessage("修正を完了できませんでした。時間をおいて再度お試しください。");
      setPhase(preview === null ? "ERROR" : "PREVIEW");
    } finally {
      coordinator.finish(generation);
    }
  };

  const submitClarification = async () => {
    const coordinator = getOperationCoordinator();
    if (coordinator.isInFlight()) return;
    const answer = clarificationAnswer.trim();
    if (answer.length === 0) {
      setErrorMessage("回答を入力するか、選択肢を選んでください。");
      return;
    }
    if (clarificationSource === "REVISION") {
      await submitRevision(answer);
      return;
    }
    const nextRequestText = `${requestText.trim()}\n補足：${answer}`.trim();
    setRequestText(nextRequestText);
    await submitGenerate(nextRequestText);
  };

  const submitSave = async () => {
    const coordinator = getOperationCoordinator();
    if (coordinator.isInFlight()) return;
    const currentToken = acceptToken;
    if (currentToken === null || preview === null || !preview.canSave) return;
    const generation = coordinator.begin();
    if (generation === null) return;

    setPhase("SAVING");
    setErrorMessage(null);
    try {
      const result = await saveMenuPlannerAction({ acceptToken: currentToken });
      if (!coordinator.isCurrent(generation)) return;
      if (!result.ok) {
        if (result.error.kind === "STALE_PREVIEW") {
          clearLineage();
          setErrorMessage(messageForError(result.error));
          setPhase("ERROR");
        } else {
          setErrorMessage(messageForError(result.error));
          setPhase("PREVIEW");
        }
        return;
      }
      setAcceptToken(null);
      setSavedMenuId(result.menuId);
      setPhase("SAVED");
    } catch {
      if (!coordinator.isCurrent(generation)) return;
      setErrorMessage("保存を完了できませんでした。時間をおいて再度お試しください。");
      setPhase("PREVIEW");
    } finally {
      coordinator.finish(generation);
    }
  };

  const showError = errorMessage !== null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <Card>
        <CardHeader>
          <h2 className="text-lg font-bold text-slate-900">希望を入力</h2>
          <p className="mt-1 text-sm text-slate-500">参照メニューの条件をもとに、確認できる下書きを作成します。</p>
        </CardHeader>
        <CardBody>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitGenerate(requestText);
            }}
          >
            <Field label="メニュー名" required>
              <input
                id="planner-menu-name"
                className={INPUT_CLASS}
                value={menuName}
                onChange={(event) => setMenuName(event.target.value)}
                maxLength={120}
                placeholder="例：短距離ブロックの準備メニュー"
                disabled={busy}
                required
              />
            </Field>

            <Field label="参照するメニュー" required hint="対象者や予定日の条件を読み取ります">
              <select
                id="planner-context-menu"
                className={INPUT_CLASS}
                value={contextMenuTemplateId}
                onChange={(event) => setContextMenuTemplateId(event.target.value)}
                disabled={busy}
                required
              >
                {contextMenus.map((menu) => <option key={menu.id} value={menu.id}>{menu.name}</option>)}
              </select>
            </Field>

            <Field label="作りたい練習内容" required hint="最大2,000文字">
              <textarea
                id="planner-request"
                className={`${INPUT_CLASS} min-h-32 resize-y`}
                value={requestText}
                onChange={(event) => setRequestText(event.target.value)}
                maxLength={2_000}
                placeholder="例：動きづくりを中心に、短時間でできる内容にしたい"
                disabled={busy}
                required
              />
            </Field>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs leading-relaxed text-slate-500">AIは選択の整理だけを行い、数値の処方はサーバー側のルールで決まります。</p>
              <Button type="submit" size="lg" disabled={busy}>
                {phase === "GENERATING" ? "作成中…" : "プレビューを作成"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {showError && errorMessage !== null && <ErrorNotice message={errorMessage} />}

      {phase === "CLARIFICATION" && clarification !== null && (
        <Card aria-labelledby="planner-clarification-heading">
          <CardHeader>
            <p className="text-xs font-medium text-indigo-600">追加の確認</p>
            <h2 id="planner-clarification-heading" className="mt-1 text-lg font-bold text-slate-900">{clarification.text}</h2>
          </CardHeader>
          <CardBody>
            {clarification.options.length > 0 && (
              <div className="flex flex-wrap gap-2" aria-label="回答の選択肢">
                {clarification.options.map((option) => (
                  <Button
                    key={option}
                    type="button"
                    variant={clarificationAnswer === option ? "primary" : "secondary"}
                    size="sm"
                    disabled={busy}
                    aria-pressed={clarificationAnswer === option}
                    onClick={() => setClarificationAnswer(option)}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            )}
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field label="回答" className="flex-1">
                <input
                  className={INPUT_CLASS}
                  value={clarificationAnswer}
                  onChange={(event) => setClarificationAnswer(event.target.value)}
                  maxLength={200}
                  disabled={busy}
                  placeholder="回答を入力"
                />
              </Field>
              <Button type="button" size="lg" disabled={busy} onClick={() => void submitClarification()}>
                {busy ? "確認中…" : "この回答で続ける"}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {showPreview && preview !== null && (
        <section aria-labelledby="planner-preview-heading" className="space-y-4">
          <div className="sr-only"><h2 id="planner-preview-heading">プレビュー</h2></div>
          <PreviewCard preview={preview} />

          {phase !== "SAVED" && (
            <Card>
              <CardHeader>
                <h2 className="text-lg font-bold text-slate-900">内容を調整</h2>
                <p className="mt-1 text-sm text-slate-500">修正内容だけを入力してください。現在のプレビューはサーバー側で確認されます。</p>
              </CardHeader>
              <CardBody>
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitRevision(revisionText);
                  }}
                >
                  <Field label="修正内容" hint="最大2,000文字">
                    <textarea
                      className={`${INPUT_CLASS} min-h-24 resize-y`}
                      value={revisionText}
                      onChange={(event) => setRevisionText(event.target.value)}
                      maxLength={2_000}
                      placeholder="例：もう少し短くして、動作づくりを増やしたい"
                      disabled={busy}
                    />
                  </Field>
                  <div className="flex justify-end">
                    <Button type="submit" variant="secondary" size="lg" disabled={busy || acceptToken === null || revisionText.trim().length === 0}>
                      {phase === "REVISING" ? "修正中…" : "この内容で修正"}
                    </Button>
                  </div>
                </form>
              </CardBody>
            </Card>
          )}

          <Card className="border-indigo-200 bg-indigo-50/60">
            <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-bold text-slate-900">この内容で保存</h2>
                <p className="mt-1 text-sm text-slate-600">保存後もメニューは下書きとして確認できます。</p>
              </div>
              <Button type="button" size="lg" disabled={busy || phase === "SAVED" || acceptToken === null || !preview.canSave} onClick={() => void submitSave()}>
                {phase === "SAVING" ? "保存中…" : "メニューを保存"}
              </Button>
            </CardBody>
          </Card>
        </section>
      )}

      {phase === "SAVED" && savedMenuId !== null && (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardBody>
            <p role="status" className="font-semibold text-emerald-900">メニューを保存しました。</p>
            <p className="mt-1 text-sm text-emerald-800">保存した下書きをメニュー一覧から確認できます。</p>
            <a href={`/menus/${savedMenuId}`} className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">
              保存したメニューを見る
            </a>
          </CardBody>
        </Card>
      )}

      {phase === "IDLE" && (
        <p role="status" className="text-center text-sm text-slate-500">入力すると、ここにプレビューが表示されます。</p>
      )}
    </div>
  );
}
