import type { ComposerCatalogExercise, ComposeMenuInput, CompositionItem, ExercisePlanItem } from "@/domain/menu-composition/contracts";
import type { VerifiedRunningIntent } from "@/application/running-menu/intent";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import type { RunningPrescription } from "@/domain/running-policy/contracts";
import catalogSnapshot from "./menu-session-quality-catalog.json";
import actualLuna from "./menu-session-quality-real-luna.json";
import shorterRecordedFixture from "./menu-session-offline-draft.json";

/** These authored plans exercise accounting contracts; they are not new model output or approved training. */
export const AUTHORED_QUALITY_PROVENANCE = "AUTHORED_OFFLINE_NOT_LUNA_NOT_COACH_APPROVED";
export const qualityCatalog = catalogSnapshot.catalog as ComposerCatalogExercise[];
export const originalQualityRequest = "高校生の100mです。来週末の試合に向けて少し疲労をためたいです。今は10が一番疲労が強いとしたら1です。";
export const full90QualityRequest = "高校生の200m選手です。走練習は150mを希望します。大会は21日後です。普段から慣れている姿勢・腕脚の連動ドリルと、自重の補助を組み合わせたいです。導入に速歩10分、整理に歩行5分を入れてください。直線走路とマットが使えます。希望時間は全体で90分です。";

type Phase = "WARM_UP" | "DRILLS_STRENGTH" | "RUNNING" | "COOL_DOWN" | "OTHER";
type TimingKind = "TIMED_DOSE" | "REP_TEMPO" | "DISTANCE_PACE" | "RUNNING_ESTIMATE";
type ItemBreakdown = {
  workSeconds: number; restSeconds: number; instructionSeconds: number; preparationSeconds: number;
  basis: { kind: TimingKind; units: number; secondsPerUnit: number; description: string; uncertainty: string; source: "PLANNING_ESTIMATE" };
  intensity: { mode: "DESCRIBED" | "UNSPECIFIED"; explanation: string };
  restExplanation: string; instructionDescription: string; preparationDescription: string;
};
type AuthoredBlock = {
  planBlockId: string; name: string; phase: Phase; allocatedSeconds: number; items: CompositionItem[];
  allocationBasis: { itemEstimatesSeconds: number[]; preparationSeconds: number; explanation: string;
    preparationDescription: string; itemBreakdowns: ItemBreakdown[] };
};
type AuthoredComposition = {
  planning: { planId: string; claimedTotalSeconds: number;
    shortfallReason: "NONE" | "FIXED_RUNNING_DOSE" | "EXPLICIT_LOW_LOAD" | "MISSING_CANDIDATES" | "UNRESOLVED_DETAILS";
    explanation: string; omittedBlocks: never[] };
  overview: { title: string; objective: string; approach: string };
  sessionPlan: { blocks: { name: string; phase: Phase; purpose: string; allocatedSeconds: number }[]; timeBudgetReasoning: string };
  blocks: AuthoredBlock[]; transitionSeconds: number; transitionDescription: string;
};
export type AuthoredQualityCase = {
  provenance: typeof AUTHORED_QUALITY_PROVENANCE; request: ComposeMenuInput;
  intent: VerifiedRunningIntent; runningPrescription: RunningPrescription;
  composition: AuthoredComposition; assumptions: string[];
};

const ids = {
  arms: "cmtsxtnwk00w6itxbiblxkogw", hips: "cmtswcp0h00voitxbo9n8558g", inchworm: "cmttg5xyy00wkitxbl5mkf9ds",
  knee: "cmtskpig200n6itxbr4wjkrnk", swing: "cmts9twus00g9itxblmdj4rgc", switch: "cmtx0ipj1000ait6kua86zv1w",
  rdl: "cmtstnvsh00thitxbaoib3s49", side: "cmtsu3ei500toitxb2xhyuzrb", hand: "cmtrdeh840017itxbb6b5pqq4",
  elbow: "cmtrdzqhe001aitxbgnaelg5i", cat: "cmtso0lp400pxitxb2r9fcfpl",
};
function catalogItem(id: string, instruction: string, reason: string,
  dose: Pick<ExercisePlanItem, "plannedSets" | "plannedReps" | "plannedDurationSeconds" | "plannedDistanceMeters" | "plannedRestSeconds">): CompositionItem {
  const row = qualityCatalog.find(exercise => exercise.id === id);
  if (!row) throw new Error(`Quality fixture catalog entry missing: ${id}`);
  return { type: "CATALOG_EXERCISE", exerciseId: id, displayName: row.name, ...dose,
    executionInstruction: instruction, reason,
    plannedNote: "登録動作を使う今回の編集可能なoffline案。数量・時間を科学的標準やコーチ承認済みとは扱わない。" };
}
const dose = (sets: number, rest: number, quantity: { reps?: number; seconds?: number; meters?: number }) => ({
  plannedSets: sets, plannedRestSeconds: rest, plannedReps: quantity.reps ?? null,
  plannedDurationSeconds: quantity.seconds ?? null, plannedDistanceMeters: quantity.meters ?? null,
});
function walk(seconds: number, closing = false): CompositionItem {
  return { type: "FREEFORM", category: closing ? "COOL_DOWN" : "WARM_UP",
    displayName: closing ? "整理の歩行" : "導入の速歩", originalUserInstruction: closing ? "整理に歩行5分" : "導入に速歩10分",
    ...dose(1, 0, { seconds }), executionInstruction: closing ? "走らず、ゆっくり歩いて終了へ進む。" : "走らず、会話できる速さで歩く。",
    plannedNote: "別入力に明示された歩行時間をそのまま使用。元の100m希望には追加しない。",
    reason: closing ? "明示希望の歩行で動きを落ち着かせる。" : "明示希望の歩行で全身を動かす。" };
}
function estimate(kind: TimingKind, units: number, secondsPerUnit: number, restSeconds: number,
  instructionSeconds: number, preparationSeconds: number, description: string,
  restExplanation: string, instructionDescription = "", preparationDescription = "",
  intensity = "反動を増やさず、登録説明の動きをコントロールして行う。", unspecified = false): ItemBreakdown {
  return { workSeconds: units * secondsPerUnit, restSeconds, instructionSeconds, preparationSeconds,
    basis: { kind, units, secondsPerUnit, description,
      uncertainty: kind === "TIMED_DOSE" ? "指定秒数の計画値。実測ではなく、実施中に調整され得る。"
        : "移動・動作周期の時間は未実測の仮定。速度目標や競技上の強度指定ではない。", source: "PLANNING_ESTIMATE" },
    intensity: { mode: unspecified ? "UNSPECIFIED" : "DESCRIBED", explanation: intensity },
    restExplanation, instructionDescription, preparationDescription };
}
function block(id: string, name: string, phase: Phase, items: CompositionItem[], estimates: ItemBreakdown[]): AuthoredBlock {
  const preparationSeconds = estimates.reduce((sum, row) => sum + row.instructionSeconds + row.preparationSeconds, 0);
  const itemEstimatesSeconds = estimates.map(row => row.workSeconds + row.restSeconds);
  return { planBlockId: id, name, phase, items,
    allocatedSeconds: preparationSeconds + itemEstimatesSeconds.reduce((sum, value) => sum + value, 0),
    allocationBasis: { itemEstimatesSeconds, preparationSeconds, itemBreakdowns: estimates,
      explanation: "項目別の運動と休息を合算し、説明・準備を別計上。テンポ・歩行時間は実測ではない。",
      preparationDescription: estimates.flatMap(row => [row.instructionDescription, row.preparationDescription]).filter(Boolean).join(" / ").slice(0, 240) } };
}
function intentFor(event: "100m" | "200m", longRun = false): VerifiedRunningIntent {
  return { runningRequested: true, event: { value: event, sourceText: event, sourceType: "USER_TEXT" },
    ageGroup: { value: "HIGH_SCHOOL", sourceText: "高校生", sourceType: "USER_TEXT" },
    explicitDistances: longRun ? [{ value: 150, sourceText: "走練習は150mを希望します。", sourceType: "USER_TEXT" }] : [],
    distancePreference: null, loadReductionRequested: null, fatigueState: null, purpose: null, intensityPreference: null,
    competitionDays: longRun ? { value: 21, sourceText: "大会は21日後です。", sourceType: "USER_TEXT" } : null,
    availableTimeSeconds: null, humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [] };
}
function engineFor(intent: VerifiedRunningIntent, request: ComposeMenuInput): RunningPrescription {
  const result = createRunningMenuPreview(intent, request.context, request.requestText);
  if (result?.status !== "READY") throw new Error("Authored fixture must use the unchanged existing Running Engine");
  return result.prescription;
}

/** A different, explicit 150m request; never substituted for the failed real 100m request. */
export function full90QualityCase(): AuthoredQualityCase {
  const request: ComposeMenuInput = { requestText: full90QualityRequest, context: { event: "200m", ageGroup: "HIGH_SCHOOL", availableTimeSeconds: 5400 } };
  const intent = intentFor("200m", true);
  const runningPrescription = engineFor(intent, request);
  const blocks = [
    block("warm-up", "導入：歩行と動的な準備", "WARM_UP", [walk(600),
      catalogItem(ids.arms, "軽く弾んで前進しながら左右交互に腕を前へ回す。20mを2セット、セット間30秒。", "肩と脚を動かし、次の動作へ入る。", dose(2, 30, { meters: 20 })),
      catalogItem(ids.hips, "後ろ向きに進み、膝を上げて外側へ回す。20mを2セット、セット間30秒。", "股関節を動かし、姿勢を確認する。", dose(2, 30, { meters: 20 })),
      catalogItem(ids.inchworm, "手を前へ歩かせて体を伸ばし、足を手元へ歩かせて腰を高く戻す。5mを1セット。", "登録された全身の支持動作を確認する。", dose(1, 0, { meters: 5 })),
    ], [
      estimate("TIMED_DOSE", 1, 600, 0, 0, 0, "本人が明示した速歩10分。", "1セットのためセット間休息なし。", "", "", "走らず会話できる速さの速歩。"),
      estimate("DISTANCE_PACE", 40, 1.5, 30, 10, 0, "20m約30秒×2。短い戻りはセット間30秒内。", "セット間30秒が1回。", "慣れた腕回しの開始合図と進行方向確認10秒。", "", "軽く弾むリズム。強い跳躍にはしない。"),
      estimate("DISTANCE_PACE", 40, 2.25, 30, 10, 0, "20m約45秒×2。短い戻りはセット間30秒内。", "セット間30秒が1回。", "後進方向と股関節の動きの確認10秒。"),
      estimate("DISTANCE_PACE", 5, 12, 0, 10, 0, "5m約60秒。手歩きと足歩きを交互に進める仮定。", "1セットのためセット間休息なし。", "床面と開始姿勢確認10秒。"),
    ]),
    block("technique", "技術：姿勢・接地・腕脚の連動", "DRILLS_STRENGTH", [
      catalogItem(ids.knee, "直立姿勢で膝を引き上げながら20m歩く。3セット、セット間60秒。", "姿勢を保った膝の引き上げを確認。", dose(3, 60, { meters: 20 })),
      catalogItem(ids.swing, "片側5回、反対側5回を1セットとして2セット。膝を上げ真下へ振り下ろす。セット間60秒。", "接地位置と腕脚の連動を確認。", dose(2, 60, { reps: 5 })),
      catalogItem(ids.switch, "小さく跳んで左右の脚を1回入れ替えて着地する動作を1回とする。左右合計6回を2セット、セット間60秒。", "腕振りと脚の切り替えを組み合わせる。", dose(2, 60, { reps: 6 })),
    ], [
      estimate("DISTANCE_PACE", 60, 3, 120, 20, 0, "20m約60秒×3。戻りは既定休息に含む。", "セット間60秒が2回。", "姿勢と歩行方向の確認20秒。"),
      estimate("REP_TEMPO", 20, 3, 60, 20, 0, "片側5回×左右×2セット。素早い振り下ろしと姿勢戻しを含む1周期約3秒。", "セット間60秒が1回。", "真下の接地位置の確認20秒。", "", "振り下ろしは素早く、姿勢を戻して次の動作へ。"),
      estimate("REP_TEMPO", 12, 5, 60, 20, 0, "左右合計6回×2セット。1回の小跳躍・着地・構え直しで約5秒。", "セット間60秒が1回。", "左右合計の数え方と腕振り確認20秒。", "", "小さく跳び、各着地で姿勢を確認する。"),
    ]),
    block("main", "走：希望した150mの既存処方", "RUNNING", [{ type: "RUNNING_POLICY" }], [
      estimate("RUNNING_ESTIMATE", runningPrescription.totalReps, 20, runningPrescription.minimumKnownRestSeconds, 60, 120,
        "150mを1本約20秒とする時間会計上の仮定。目標タイム・強度指定ではない。",
        "既存Engineの本間1080秒×2。戻り・飲水はその休息内。最後の本の後に本間休息を加えない。",
        "処方と開始手順の説明60秒。", "レーン・開始位置・ゴール位置の確認120秒。",
        "Engineは強度・目標タイムを未指定。計画用の20秒から強度を補完しない。", true),
    ]),
    block("support", "補助：慣れた自重動作と体幹制御", "DRILLS_STRENGTH", [
      catalogItem(ids.rdl, "器具を持たず、膝を軽く曲げたまま股関節を引き上体を倒し戻す。10回を3セット、セット間90秒。", "慣れた股関節主導の動作を確認する。", dose(3, 90, { reps: 10 })),
      catalogItem(ids.side, "横向きで上側の膝を曲げた脚を上げ下げする。片側10回→反対側10回で1セット。2セット、セット間60秒。", "骨盤を保った脚の制御を練習する。", dose(2, 60, { reps: 10 })),
      catalogItem(ids.hand, "仰向けで腰と床の間の手を腰で押さえる。呼吸を止めず30秒を2セット、セット間60秒。", "腹圧と呼吸を両立して姿勢を保つ。", dose(2, 60, { seconds: 30 })),
      catalogItem(ids.elbow, "膝と対角の肘を寄せて戻す。片側10回を終えてから反対側10回。左右交互にしない。これを2セット、セット間60秒。回数欄は片側10回。", "確認済みの動作順序と数え方で体幹を使う。", dose(2, 60, { reps: 10 })),
    ], [
      estimate("REP_TEMPO", 30, 4, 180, 30, 0, "10回×3セット。倒す2秒・戻す2秒という仮定。", "セット間90秒×2。慣れた動作をフォーム確認しながら行う今回の暫定休息。", "器具なしの股関節動作を確認30秒。", "", "器具を持たず反動なし。限界まで追い込む指示ではない。"),
      estimate("REP_TEMPO", 40, 3, 60, 30, 0, "片側10回×左右×2セット、上げ下げ約3秒。", "セット間60秒が1回。", "横向き姿勢と左右の切替確認30秒。"),
      estimate("TIMED_DOSE", 2, 30, 60, 30, 0, "30秒×2セット。保持時間に説明時間を混ぜない。", "セット間60秒が1回。", "腰と手の位置、呼吸の確認30秒。", "", "呼吸を続けられる腹圧で保持。"),
      estimate("REP_TEMPO", 40, 3, 60, 30, 0, "PER_SIDE10×左右×2セット。寄せて戻す約3秒/周期。コーチ定義の片側完了後に反対側を維持。", "セット間60秒が1回。", "仰向け姿勢と片側完了順序の確認30秒。", "", "反動を使わず、寄せて戻す動作を制御する。"),
    ]),
    block("closing", "整理：歩行と終了時の確認", "COOL_DOWN", [walk(300, true),
      catalogItem(ids.cat, "四つ這いで背中を丸める→反らせる往復を1回として6回。ゆっくり呼吸を続ける。", "穏やかな動作で状態を確認して終了する。回復効果は断定しない。", dose(1, 0, { reps: 6 })),
    ], [
      estimate("TIMED_DOSE", 1, 300, 0, 0, 0, "本人が明示した歩行5分。", "1セットのためセット間休息なし。", "", "", "ゆっくり歩く。"),
      estimate("REP_TEMPO", 6, 5, 0, 20, 10, "丸める・反らせる1往復約5秒×6。", "1セットのためセット間休息なし。", "終了時の疲労感を言葉で確認20秒。", "四つ這いの位置を整える10秒。", "反動を使わない穏やかな動作。"),
    ]),
  ];
  const total = blocks.reduce((sum, row) => sum + row.allocatedSeconds, 0) + 240;
  if (total !== 5400) throw new Error(`Authored 90-minute accounting changed: ${total}`);
  return { provenance: AUTHORED_QUALITY_PROVENANCE, request, intent, runningPrescription,
    composition: { blocks, transitionSeconds: 240,
      transitionDescription: "4回のブロック間移動を各60秒。走路・マットへの移動等で、ブロック内準備と本間休息へ二重計上しない。",
      planning: { planId: "authored-full90", claimedTotalSeconds: total, shortfallReason: "NONE",
        explanation: "別の明示150m希望と普段の補助練習を量から計算した90分枠。元の100m希望を90分へ改変した案ではない。", omittedBlocks: [] },
      overview: { title: "150m希望と慣れた補助を組み合わせるoffline計画", objective: "姿勢・腕脚の連動を確認し、希望した150mの既存処方と慣れた補助を組み合わせる。",
        approach: "導入15分、技術10分、走40分、補助15分、整理6分、移動4分。具体的な量・休息から計90分を構成。実AI出力や科学的保証ではなく、個別テンポ・準備・強度とスプリント準備の十分性は確認対象。" },
      sessionPlan: { blocks: blocks.map(row => ({ name: row.name, phase: row.phase, allocatedSeconds: row.allocatedSeconds,
        purpose: row.items.map(item => item.type === "RUNNING_POLICY" ? "固定の走処方をそのまま実施。" : item.reason).join(" ").slice(0, 160) })),
        timeBudgetReasoning: "15+10+40+15+6+移動4=90分。走は既存150m×3本・本間18分を維持。明示した歩行と慣れた動作の量から時間を算定し、未記載の待機を加えない。" } },
    assumptions: ["別の明示入力によるoffline会計検証。元の実Luna失敗を成功に置換しない。", "150mは利用者希望。希望時間を埋めるための距離変更ではない。",
      "記載の補助は普段から行う自重動作という条件。新しい高負荷や筋力効果の保証はない。", "走行20秒は時間会計の仮定で、Engineの未指定強度を埋めない。",
      "移動・説明・周期は仮定。十分な競技準備と実際の所要時間を保証しない。"] };
}

/** Existing authored 37-minute example, enhanced only with auditable item-level time metadata. */
export function shorterQualityCase(): AuthoredQualityCase {
  const request: ComposeMenuInput = { requestText: originalQualityRequest, context: { availableTimeSeconds: 5400 } };
  const intent = intentFor("100m");
  const runningPrescription = engineFor(intent, request);
  const source = structuredClone(shorterRecordedFixture.composition);
  const rows: ItemBreakdown[][] = [
    [estimate("DISTANCE_PACE", 20, 2, 0, 30, 0, "20m約40秒の仮定。", "1セット。", "腕回しの説明30秒。"),
      estimate("DISTANCE_PACE", 20, 3, 0, 30, 0, "20m約60秒の仮定。", "1セット。", "股関節回しの説明30秒。"),
      estimate("DISTANCE_PACE", 5, 10, 0, 30, 0, "5m約50秒の仮定。", "1セット。", "くの字姿勢の説明30秒。")],
    [estimate("DISTANCE_PACE", 40, 3, 60, 30, 0, "20m約60秒×2。戻りは休息内。", "セット間60秒が1回。", "ニーアップ姿勢確認30秒。"),
      estimate("REP_TEMPO", 20, 3, 60, 30, 0, "片側5回×左右×2、姿勢戻し込み約3秒。", "セット間60秒が1回。", "真下の接地確認30秒。")],
    [estimate("RUNNING_ESTIMATE", 4, 10, 720, 80, 120, "60mの時間会計仮定10秒×4。目標ではない。", "固定本間240秒×3。戻りを含む。", "開始手順の説明80秒。", "レーン・開始位置の確認120秒。", "Engineの強度・目標タイムは未指定。", true)],
    [estimate("TIMED_DOSE", 2, 20, 45, 30, 30, "20秒保持×2。", "セット間45秒が1回。", "姿勢説明30秒。", "床・マットの位置確認30秒。"),
      estimate("REP_TEMPO", 20, 3, 0, 30, 5, "片側10回→反対側10回、1周期約3秒。", "1セット。", "動作と片側順序確認30秒。", "左右の姿勢切替5秒。")],
    [estimate("REP_TEMPO", 6, 6, 0, 18, 0, "丸める・反らせる6往復、約6秒/往復。", "1セット。", "姿勢切替と説明18秒。"),
      estimate("REP_TEMPO", 12, 4, 0, 78, 0, "片側6回×左右、開いて戻す約4秒/周期。", "1セット。", "姿勢切替と説明18秒、終了時の疲労感の言語化60秒。")],
  ];
  const blocks = source.blocks.map((row, index) => block(["warm-up", "technique", "main", "support", "closing"][index], row.name,
    row.phase as Phase, row.items as CompositionItem[], rows[index]));
  return { provenance: AUTHORED_QUALITY_PROVENANCE, request, intent, runningPrescription,
    composition: { overview: source.overview, transitionSeconds: source.transitionSeconds,
      transitionDescription: source.transitionDescription, blocks,
      sessionPlan: { blocks: blocks.map((row, index) => ({ name: row.name, phase: row.phase,
        allocatedSeconds: row.allocatedSeconds, purpose: source.sessionPlan.blocks[index].purpose })),
        timeBudgetReasoning: source.sessionPlan.timeBudgetReasoning },
      planning: { planId: "authored-shorter", claimedTotalSeconds: 2220,
      shortfallReason: "UNRESOLVED_DETAILS", explanation: "計画37分、希望との差53分。希望する疲労負荷を表す活動・量が未決定。固定走の変更や追加待機で埋めない。候補不足や37分が最大と断定しない。", omittedBlocks: [] } },
    assumptions: ["既存の手書き37分例であり、実AI出力ではない。", "53分を未配分のまま残す。", "元の疲労希望の達成、走強度、十分なスプリント準備は未確認。"] };
}

/** Explicit low-load alternative: its own Engine result, never an edit to the real 60m×4 result. */
export function lightweightShorterQualityCase(): AuthoredQualityCase {
  const result = shorterQualityCase();
  result.request = { requestText: "高校生の100m選手です。今日は軽めに本数を少なくして、全体の準備・走・体幹・整理を行いたいです。時間枠は90分ですが、必要な内容が終われば短く終了します。",
    context: { event: "100m", ageGroup: "HIGH_SCHOOL", availableTimeSeconds: 5400 } };
  result.intent = { ...intentFor("100m"), loadReductionRequested: {
    value: true, sourceText: "今日は軽めに本数を少なくして", sourceType: "USER_TEXT" } };
  result.runningPrescription = engineFor(result.intent, result.request);
  const running = result.runningPrescription;
  const main = result.composition.blocks[2];
  main.allocationBasis.itemBreakdowns = [estimate("RUNNING_ESTIMATE", running.totalReps, 10,
    running.minimumKnownRestSeconds, 80, 120,
    "今回の明示的な本数削減希望に対してEngineが返した60m×3本。計画仮定10秒/本は強度指定ではない。",
    "Engineの本間240秒×2を維持。戻りはこの休息内。", "開始手順の説明80秒。", "レーン・開始位置確認120秒。",
    "Engineの強度・目標タイムは未指定。", true)];
  main.allocationBasis.itemEstimatesSeconds = [running.totalReps * 10 + running.minimumKnownRestSeconds];
  main.allocatedSeconds = main.allocationBasis.itemEstimatesSeconds[0] + main.allocationBasis.preparationSeconds;
  result.composition.sessionPlan.blocks[2].allocatedSeconds = main.allocatedSeconds;
  result.composition.sessionPlan.blocks[2].purpose = "この別入力に対するEngineの処方を変更せず実施する。";
  const total = result.composition.blocks.reduce((sum, row) => sum + row.allocatedSeconds, 0) + result.composition.transitionSeconds;
  result.composition.overview = { title: "明示的な軽め希望の短いoffline計画",
    objective: "軽めに本数を減らしたい希望を既存Engineへ渡し、準備・走・補助・整理を具体化する。",
    approach: "32分50秒の案。90分枠の残り57分10秒を量や待機で埋めず、必要な内容で終了する。実AI出力や生理学的効果の保証ではない。" };
  result.composition.planning = { planId: "authored-lightweight-shorter", claimedTotalSeconds: total,
    shortfallReason: "EXPLICIT_LOW_LOAD", explanation: "短く終了してよいという本人の明示希望。必要な実施量から32分50秒を計画し、残り57分10秒を追加負荷や待機へ変換しない。", omittedBlocks: [] };
  result.composition.sessionPlan.timeBudgetReasoning = "準備4分、技術6分、走11分50秒、補助4分、整理3分、移動4分=32分50秒。本人の軽め希望に従い残り57分10秒を未配分とする。";
  result.assumptions = ["元の疲労をためたい希望とは別入力。本人が軽めと短縮を明示したoffline例。",
    "60m×3本は既存Engineの出力。実Lunaの60m×4本を手動編集した結果ではない。",
    "量と時間の整合を確認する例で、十分な競技準備や個人への生理学的適合を保証しない。"];
  return result;
}

/** Provenance remains real output; no authored metadata is inserted into its response. */
export function real39QualityCase() {
  return { provenance: "REAL_LUNA_SINGLE_GENERATION_20261012", request: { requestText: originalQualityRequest, context: { availableTimeSeconds: 5400 } },
    runningPrescription: structuredClone(catalogSnapshot.runningPrescription), composition: structuredClone(actualLuna) };
}

/** A deliberately invalid 90-minute label produced by padding the honest shorter plan. */
export function padded90QualityCase(): AuthoredQualityCase {
  const result = shorterQualityCase();
  const main = result.composition.blocks[2];
  main.allocatedSeconds += 3180;
  main.allocationBasis.preparationSeconds += 3180;
  main.allocationBasis.itemBreakdowns[0].preparationSeconds += 3180;
  main.allocationBasis.itemBreakdowns[0].preparationDescription = "90分へ合わせるため、既定休息以外に待機53分を追加する。";
  main.allocationBasis.preparationDescription = main.allocationBasis.itemBreakdowns[0].preparationDescription;
  result.composition.sessionPlan.blocks[2].allocatedSeconds = main.allocatedSeconds;
  result.composition.planning.claimedTotalSeconds = 5400;
  result.composition.planning.shortfallReason = "NONE";
  result.composition.planning.explanation = "算術だけを90分へ合わせた意図的な不正例。";
  result.composition.sessionPlan.timeBudgetReasoning = "37分案へ意味のない待機53分を加え、90分と称する不正例。";
  return result;
}

/** Let tests bind the same authored proposal to the deterministic App planner's identities. */
export function bindQualityCasePlan<T extends AuthoredQualityCase>(value: T,
  plan: { id: string; blocks: readonly { id: string }[] }): T {
  const result = structuredClone(value);
  if (plan.blocks.length !== result.composition.blocks.length) throw new Error("Fixture/plan block count differs");
  result.composition.planning.planId = plan.id;
  result.composition.blocks.forEach((row, index) => { row.planBlockId = plan.blocks[index].id; });
  return result;
}
