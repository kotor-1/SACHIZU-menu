import type { ComposeMenuInput, ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import type { AppSessionPlan, SessionRole } from "@/domain/menu-composition/session-planning";
import type { RunningPrescription } from "@/domain/running-policy/contracts";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import { isRunningExerciseForV2 } from "@/presentation/running/legacy-routing";
import type { VerifiedRunningIntent } from "@/application/running-menu/intent";
import { composerCatalogRoles, type ComposerCatalogRole } from "./catalog";

type Block = AppSessionPlan["blocks"][number];
const ROLE_DETAILS: Record<SessionRole, Pick<Block, "name" | "purpose" | "phase">> = {
  WARM_UP: { name: "導入・ウォーミングアップ", phase: "WARM_UP", purpose: "登録済みの準備動作を選び、次の練習へ進む準備を具体化する。" },
  TECHNIQUE: { name: "動きづくり・技術", phase: "DRILLS_STRENGTH", purpose: "今回のメイン練習と関係する動作を登録候補から選ぶ。" },
  MAIN: { name: "メイン練習", phase: "RUNNING", purpose: "固定のRunning処方を変更せず配置し、実施と既定休息の時間を示す。" },
  SUPPORT: { name: "補助・補強", phase: "DRILLS_STRENGTH", purpose: "目的に関係する補助動作を選び、時間合わせによる量の追加を避ける。" },
  COOL_DOWN: { name: "整理・終了時の確認", phase: "COOL_DOWN", purpose: "登録済みの整理動作と終了時の状態確認を具体化する。" },
  FOCUSED: { name: "希望した練習", phase: "OTHER", purpose: "明示された範囲の登録種目と実施量だけを具体化する。" },
};
const CATALOG_ROLES: Partial<Record<SessionRole, readonly ComposerCatalogRole[]>> = {
  WARM_UP: ["INTRO", "MOBILITY"], TECHNIQUE: ["TECHNIQUE"], SUPPORT: ["SUPPORT"], COOL_DOWN: ["CLOSING"],
};

/** Integer scheduling shares, with whole-minute shares where the budget permits. */
function distribute(seconds: number, weights: readonly number[]): number[] {
  const unit = seconds >= 60 * weights.length ? 60 : 1;
  const units = Math.floor(seconds / unit);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const exact = weights.map(weight => units * weight / totalWeight);
  const shares = exact.map(Math.floor);
  const order = exact.map((value, index) => ({ index, fraction: value - shares[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let left = units - shares.reduce((sum, value) => sum + value, 0), i = 0; left > 0; left--, i++) shares[order[i].index]++;
  return shares.map((value, index) => value * unit + (index === 0 ? seconds % unit : 0));
}

/** The App allocates ceilings for scheduling; it never creates or edits an exercise dose. */
export function buildAppSessionPlan(input: ComposeMenuInput, intent: VerifiedRunningIntent,
  catalog: readonly ComposerCatalogExercise[], running: RunningPrescription | null): AppSessionPlan {
  const text = input.requestText.normalize("NFKC");
  const requestedSeconds = intent.availableTimeSeconds?.value ?? input.context.availableTimeSeconds ?? null;
  const eligible = catalog.filter(row => row.status === "REVIEWED" && !isRunningExerciseForV2(row));
  const constraints: AppSessionPlan["constraints"] = [];
  const rationale = ["配分はAppが先に設ける編集用の時間上限です。実施量・休息・強度の処方、実所要時間、希望時間を満たした判定ではありません。",
    "以下の時間配分は進行のための仮置きで、科学的な標準時間ではありません。内容が合理的に収まらなければ短い案と不足理由を返します。"];
  const explicitWhole = /全体|一通り|導入から|アップから|ウォーミングアップから/u.test(text);
  const scopeText = text.replace(/(?:だけ|のみ)(?:ではなく|でなく|じゃなく|で終わらず)/gu, "も含め");
  const onlyRunning = /(?:走|走練習|ランニング|スプリント)(?:の練習)?(?:だけ|のみ)/u.test(scopeText);
  const focusedSupport = /(?:補強|体幹|筋トレ)(?:だけ|のみ)/u.test(scopeText);
  const focusedClosing = /(?:ストレッチ|整理運動|クールダウン)(?:だけ|のみ)/u.test(scopeText);
  const focusedWarmup = /(?:アップ|ウォーミングアップ)(?:だけ|のみ)/u.test(scopeText);
  const explicitlyFocused = onlyRunning || focusedSupport || focusedClosing || focusedWarmup || /(?:だけ|のみ)(?:を|の|で|。|$)/u.test(scopeText);
  const focused = !explicitWhole && (explicitlyFocused || requestedSeconds !== null && requestedSeconds <= 1800);
  const lowLoad = !!intent.loadReductionRequested || intent.intensityPreference?.value === "LOW"
    || intent.purpose?.value === "RECOVERY" || intent.purpose?.value === "PRECOMP";
  const fatigue = intent.fatigueState?.value;
  const days = intent.competitionDays?.value;
  const competitionNear = days !== undefined && days <= 7;
  const age = intent.ageGroup?.value ?? input.context.ageGroup;
  const beginner = input.context.science?.experience === "BEGINNER";
  const younger = age === "ELEMENTARY" || age === "JUNIOR_HIGH";
  const roles: SessionRole[] = focused
    ? onlyRunning || (!explicitlyFocused && intent.runningRequested) ? ["MAIN"] : ["FOCUSED"]
    : ["WARM_UP", "TECHNIQUE", ...(intent.runningRequested || running ? ["MAIN" as const] : []), "SUPPORT", "COOL_DOWN"];

  if (intent.availableTimeSeconds && input.context.availableTimeSeconds !== undefined
    && intent.availableTimeSeconds.value !== input.context.availableTimeSeconds) {
    constraints.push({ code: "TIME_CONTEXT_CONFLICT", message: "文章と入力欄の希望時間が異なります。希望時間の確認が必要です。" });
  }
  if (/疲労.{0,6}(?:ため|溜め|貯め)|追い込/u.test(text)) {
    constraints.push({ code: "FATIGUE_GOAL_UNRESOLVED", message: "疲労をためたい希望に対する負荷の達成は未確認です。固定の走処方や補強量を時間合わせで増やさず、目的との関係を確認してください。" });
  }
  if (!intent.fatigueState && /(?:\d+.{0,15}疲労|疲労.{0,15}\d+|\d+段階)/u.test(text)) {
    constraints.push({ code: "FATIGUE_SCALE_UNRESOLVED", message: "本人の数値による疲労報告は保持します。独自尺度を疲労区分や負荷へ変換していません。" });
  }
  if (days === undefined && /試合|大会|レース/u.test(text)) {
    constraints.push({ code: "COMPETITION_DATE_UNRESOLVED", message: "大会までの正確な日数は未確認です。来週末などの表現から日数や調整期を推定していません。" });
  }
  if (roles.includes("MAIN") && !running) {
    constraints.push({ code: "RUNNING_PRESCRIPTION_UNAVAILABLE", message: "走の処方が未確定です。メインの時間枠から距離・本数・強度・休息を生成しないでください。" });
  }
  if (fatigue === "STRONG_OR_UNWELL") {
    constraints.push({ code: "REPORTED_CONDITION_REQUIRES_REVIEW", message: "検証済みの強い疲労・不調の申告があります。時間配分だけでは実施の可否を判断できません。" });
  }

  const focusedRoles: readonly ComposerCatalogRole[] | undefined = focusedSupport ? ["SUPPORT"]
    : focusedClosing ? ["CLOSING", "MOBILITY"] : focusedWarmup ? ["INTRO", "MOBILITY"] : undefined;
  const explicitlySelected = new Set(intent.exerciseIds);
  const blocks: Block[] = roles.map(role => {
    const matches = role === "MAIN" ? [] : eligible.filter(row => {
      if (role === "FOCUSED") {
        if (explicitlySelected.size > 0) return explicitlySelected.has(row.id);
        return !focusedRoles || composerCatalogRoles(row).some(candidateRole => focusedRoles.includes(candidateRole));
      }
      return composerCatalogRoles(row).some(candidateRole => CATALOG_ROLES[role]?.includes(candidateRole));
    });
    const required = role !== "SUPPORT" || !(lowLoad || fatigue || competitionNear || younger || beginner);
    if (!matches.length && role !== "MAIN" && required) constraints.push({ code: `MISSING_${role}_CANDIDATES`,
      message: `${ROLE_DETAILS[role].name}に使う登録候補がありません。種目を捏造せず、不足として示してください。` });
    return { ...ROLE_DETAILS[role], id: "", role, required, budgetSeconds: null,
      candidateIds: [...new Set(matches.map(row => row.id))].sort() };
  });

  let transitionBudgetSeconds: number | null = requestedSeconds === null ? null : 0;
  if (requestedSeconds !== null) {
    if (focused) {
      blocks[0].budgetSeconds = Math.max(requestedSeconds, roles[0] === "MAIN" ? running?.minimumKnownRestSeconds ?? 0 : 0);
      rationale.push("短時間または範囲を限定した希望は1つの作業枠として保持します。全体練習や移動枠を自動で追加しません。");
    } else {
      // One minute per transition is a ceiling, not prescribed waiting time.
      transitionBudgetSeconds = Math.min((blocks.length - 1) * 60, Math.floor(requestedSeconds / 10));
      const main = blocks.find(block => block.role === "MAIN");
      const rest = main ? running?.minimumKnownRestSeconds ?? 0 : 0;
      if (rest > requestedSeconds) {
        transitionBudgetSeconds = 0;
        blocks.forEach(block => { block.budgetSeconds = block === main ? rest : 0; });
      } else {
        const available = requestedSeconds - transitionBudgetSeconds;
        // Four minutes is scheduling headroom, never a new run time or rest interval.
        const reserve = running ? Math.ceil((rest + 240) / 60) * 60 : 0;
        const preferredMain = Math.floor(available * (intent.purpose?.value === "SPEED_ENDURANCE" ? 0.4 : 0.3) / 60) * 60;
        const mainBudget = main ? Math.min(Math.max(reserve, preferredMain, rest), requestedSeconds) : 0;
        transitionBudgetSeconds = Math.min(transitionBudgetSeconds, requestedSeconds - mainBudget);
        if (main) main.budgetSeconds = mainBudget;
        const otherBlocks = blocks.filter(block => block !== main);
        const weights = otherBlocks.map(block => {
          if (block.role === "WARM_UP") return 15 + (beginner || younger ? 5 : 0);
          if (block.role === "TECHNIQUE") return 10 + (beginner || intent.purpose?.value === "ACCEL" || intent.purpose?.value === "BASIC" ? 5 : 0);
          if (block.role === "SUPPORT") return lowLoad || fatigue ? 5 : competitionNear || younger ? 8 : 15;
          return 6 + (lowLoad || fatigue || competitionNear ? 4 : 0);
        });
        const shares = distribute(requestedSeconds - mainBudget - transitionBudgetSeconds, weights);
        otherBlocks.forEach((block, index) => { block.budgetSeconds = shares[index]; });
      }
      rationale.push("移動は隣接ブロックごとに最大1分の仮枠です。実際の移動・準備作業がなければ使わず、待機時間へ変換しません。");
      if (running) rationale.push(`固定の走の既知休息${running.minimumKnownRestSeconds}秒を下回らない枠を確保します。休息に4分の進行余地を加えた候補枠と全体の配分比を比較しますが、走行時間や休息を追加する指示ではありません。`);
    }
    if (running && blocks.some(block => block.role === "MAIN") && running.minimumKnownRestSeconds > requestedSeconds) {
      constraints.push({ code: "FIXED_RUNNING_EXCEEDS_REQUESTED_TIME", message: "固定の走の既知休息だけで希望時間を超えます。休息を短縮せず、希望時間または処方の確認が必要です。" });
    }
  }
  if (lowLoad) rationale.push("検証済みの軽負荷・調整・回復の希望を受け、補助枠を任意とし短縮を許容します。時間を満たすための量の追加は行いません。");
  if (fatigue) rationale.push("検証済みの疲労申告を受け、補助は任意の枠とします。申告から新しい処方や回復効果を導いていません。");
  if (days !== undefined) rationale.push(`検証済みの大会まで${days}日という情報を保持します。${competitionNear ? "直近のため補助枠の採用は要確認としますが、調整期や負荷軽減を自動決定しません。" : "日程だけで練習目的や処方を変更しません。"}`);
  if (beginner || younger) rationale.push("明示された経験または年齢区分を受け、説明と動作確認を配置しやすい配分にします。年齢から成熟度や技能を推定しません。");
  if (intent.purpose) rationale.push(`検証済みの目的${intent.purpose.value}を配置の重みに使います。時間枠はその目的を達成した判定ではありません。`);
  if (requestedSeconds === null) rationale.push("希望時間が未指定のため配分は未設定です。時間を創作して全体合計を確定しません。");

  const id = sha256Utf8Hex(canonicalStringify({ version: "app-session-plan-v1", input, intent, catalog: eligible, running }));
  blocks.forEach((block, index) => { block.id = `${id.slice(0, 16)}-${index + 1}-${block.role}`; });
  return { version: "app-session-plan-v1", id, requestedSeconds, scope: focused ? "FOCUSED" : "WHOLE_SESSION",
    blocks, transitionBudgetSeconds, constraints, rationale, allowsLowLoadShortening: lowLoad };
}
