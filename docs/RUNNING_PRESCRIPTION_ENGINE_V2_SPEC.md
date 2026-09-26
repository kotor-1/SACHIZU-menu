# Running Prescription Engine v2 Implementation Specification

- 文書バージョン: spec-rpe-v2.0.0（2026-09-15）
- 対象リポジトリ: SACHIZU メニュー作成（branch `main` / HEAD `ed63f91`。前回監査から `src/` `prisma/` は無変更を確認済み）
- 入力資料: `docs/` の6点（Audit v1 / Perplexity / Claude / ChatGPT / Gemini Deep Research / Fable 5.1 反証レビュー）
- 本書の性質: **実装仕様**。科学的再調査はしていない。数値の科学的妥当性を本書が保証するものではない。

## 0. 読み方

### 0.1 判断ラベル（全設計判断に付与）

| ラベル | 意味 | 実装上の扱い |
| --- | --- | --- |
| **[SOURCE-BACKED]** | 4つの Deep Research のいずれかが出典（著者・年・種類）を挙げて報告している | ルールデータに `EvidenceRecord` を必ず紐付ける。verification は一次資料または公式資料を実際に照合した記録だけ `PRIMARY_CHECKED` とし、それ以外は `SECONDARY_REPORT_ONLY` とする |
| **[ENGINE-POLICY]** | 研究では決まらないため、本アプリが安全側・実装都合で決めたもの | `sourceType: "ENGINE_POLICY"`, `provisional: true` を付ける。**科学的事実として表示しない** |
| **[OPEN]** | 未決定。本書では暫定値または無効化で扱い、§24 に論点として残す | 暫定値を置く場合は ENGINE-POLICY と併記する |

> **重要**: [SOURCE-BACKED] は、出典が研究または公式資料に基づくことを示すだけで、派生したRuleSet値をその資料の直接処方とみなす意味ではない。一次資料・公式資料を実際に照合した記録は `PRIMARY_CHECKED`、Deep Research経由の未照合記録は `SECONDARY_REPORT_ONLY` と明示する。Gemini の「Thomas 2018 = RCT」「10m=60秒は PCr 研究で強く支持」「女性はレスト×0.95」は Fable と他3レポートにより否定・弱化されているため、**本書では採用しません**。

### 0.2 用語
- **Method**: 生理学・回復構造・安全制約・stop logic のための内部分類（10種、コーチには原則見せない）
- **SessionTemplate**: コーチが認識する練習名称・形式（例「フライ20m」「300+100」）
- **Envelope**: Method×Template×Tier ごとの許容範囲（recommended / coachEditable / hardSafety の3層）
- **Tier**: `DEVELOPMENTAL | ADVANCED`（Envelope の系統）
- **Subject**: 処方対象（v2 初期は GROUP のみ実装、ATHLETE は型だけ用意）

---

## 1. Architecture

### 1.1 位置づけ（不変条件）

| 層 | 意味 | v2 での扱い |
| --- | --- | --- |
| `Exercise` | 知識 | **変更しない**。Running v2 は動画 Exercise を読まない・書かない |
| `MenuItem` | 計画 | Running v2 の処方結果の**唯一の保存先**（列追加あり §16） |
| `SessionItem` | 実績 | `createSessionFromMenu()` によるコピーで計画をスナップショット。**参照方式にしない** |
| Running Prescription Engine | MenuItem を作る domain engine | **第4の永続層ではない**。DB テーブルを持たない（Competition は計画カレンダーとして §16 で別途追加） |

- [ENGINE-POLICY] 研究更新の追跡に必要な情報（ruleSetVersion / contentHash / provenance / rationale）は **MenuItem と SessionItem の列**として保存する。エンジン専用テーブルは作らない。
- [ENGINE-POLICY] ルールセット本体（数値・Evidence）は **リポジトリ内の versioned JSON**。DB には版番号とハッシュだけを保存する。

### 1.2 旧エンジンとの共存
- `src/domain/prescription/`（以下 legacy）は **R0 で凍結**（golden test で現挙動を固定）。R12 まで削除・係数変更をしない。
- legacy は非走種目（JUMP/STRENGTH/CORE 等）の「推奨処方を入れる」に引き続き使う。
- 走トレーニングは R10 以降 v2 のみから作成する。legacy の走系 Kind（SPEED_* / TEMPO_AEROBIC）の自動入力は R10 で UI から外す（コードは R12 まで残す）。
- **係数（LEVEL_VOLUME_FACTOR / PHASE_ADJUSTMENT）の削除は R12**。前提: R3 Constraint 層と R4 planning が全テスト通過し、R10 で UI が v2 に切替済みであること。[ENGINE-POLICY]（Fable C-1 の順序条件）

### 1.3 実行場所
- [ENGINE-POLICY] v2 エンジンは **サーバーでのみ実行**（Server Actions / Server Components）。
  - 理由: ルールセット JSON をクライアントバンドルに載せない／contentHash の一貫性／AI 境界をサーバーに閉じる。
- クライアントには表示用 DTO `RunningPrescriptionView` だけを渡す。

### 1.4 ディレクトリ構成（新規）

```
src/domain/running/
├── types/            … 型と Zod スキーマ（R1）
│   ├── primitives.ts     Range / SoftRange / QuantityInterval / Confidence / Brand
│   ├── method.ts         RunningTrainingMethod, MethodMeta
│   ├── template.ts       TemplateIdByMethod, SessionTemplate<M>
│   ├── subject.ts        Subject, AgeBand, Maturity, TrainingAge, PerformanceMark
│   ├── intensity.ts      IntensityReference (discriminated union)
│   ├── prescription.ts   RunningPrescription（出力）, RepSpec
│   ├── findings.ts       Finding, FindingSeverity, RationaleLine
│   ├── readiness.ts      ReadinessReport, PainReport, ReadinessAction
│   ├── load.ts           LoadEvent, LoadCategory
│   └── actor.ts          Actor, CoachActor（branded）
├── evidence/         … EvidenceRecord, deriveDirectness, derivePrescriptionConfidence（R1）
├── rules/            … versioned rule sets（R2）
│   ├── manifest.json     版一覧 + contentHash
│   ├── schema.ts         RuleSetSchema（Zod）
│   ├── loader.ts         getRuleSet(version) / getActiveRuleSet(date)
│   └── sets/rs-2026.09.0.json
├── context/          … ageBand / maturity / trainingAge / tier / constraints / performance（R3）
├── planning/         … planRunningPrescription（R4）
├── readiness/        … pain gate / resolveReadinessAction（R5）
├── aggregation/      … evaluateSessionAggregation（R6）
├── plausibility/     … checkInputPlausibility / checkOutputPlausibility（R6）
├── weekly/           … evaluateWeeklyContext（R7）
├── competition/      … phase / competitionPriority / taper（R7）
├── monitoring/       … monitorRunningPrescription（R8）
├── rationale/        … RationaleLine の日本語レンダラ（enum キーを表示しない）
└── index.ts          … 公開 API のみ export
```

### 1.5 公開 API（これ以外を `index.ts` から export しない）

| 関数 | フェーズ | 役割 |
| --- | --- | --- |
| `getActiveRuleSet(at: IsoDate): RuleSet` | R2 | 有効なルールセットを返す |
| `resolveSubjectProfile(input): SubjectProfile` | R3 | ageBand / maturity / trainingAge / tier / constraints を確定 |
| `planRunningPrescription(req: PlanRequest): PlanResult` | R4 | 1 項目の処方 |
| `resolveReadinessAction(report, ctx): ReadinessDecision` | R5 | 当日の離散アクション |
| `evaluateSessionAggregation(items, ctx): SessionAggregate` | R6 | メニュー全体の集計と判定 |
| `checkOutputPlausibility(p): Finding[]` | R6 | 入力ミス・単位破綻の検出 |
| `evaluateWeeklyContext(history, planned, ctx): WeeklyContextResult` | R7 | 直近履歴（全カテゴリ）と大会近接 |
| `monitorRunningPrescription(state, obs): MonitorDecision` | R8 | 実施中の rep ごとの判定 |

- [ENGINE-POLICY] `plan()` と `monitor()` は**別関数**。Stop Rule は planning pipeline に置かない（Fable M-8）。

### 1.6 依存ルール
- `src/domain/running/**` が import してよいもの: `zod`、`src/domain/**` の型と定数。
- 禁止: `@prisma/client`、`react`、`next/*`、AI SDK、`node:*`（hash 計算はテスト側で行う）。
- [ENGINE-POLICY] `eslint.config.mjs` に `no-restricted-imports` を `src/domain/running/**` 限定で追加（R1）。

### 1.7 データフロー全体

```
[計画時]
 UI(コーチ) / AI MenuPlanner(提案のみ)
      │  PlanRequest（method, templateId, subjectRef, menu context）
      ▼
 Server Action ──► resolveSubjectProfile ──► planRunningPrescription ──► evaluateSessionAggregation
      │                                                   (menu 内の全項目)
      ▼
 MenuItem（prescriptionKind="RUNNING_V2", 列 + prescriptionJson + provenanceJson + rationale）

[練習作成時]  Session 作成の application layer（R10）：保存済み MenuItem の ruleSetVersion + contentHash に一致する
              RuleSet を明示的に読み、evaluateSessionAggregation / evaluateWeeklyContext を実行（active 版で代用しない）
      │  SessionPlanningEvaluationInput（データ）
      ▼
 createSessionFromMenu()（repository）：コピーのみ（再計算しない・ルール参照しない・評価しない）
      ▼
 SessionItem（planned* + running snapshot 列）  ＋ 渡された評価結果と RuleSet 非依存の検証結果を TrainingSession.planningSnapshotJson に保存

[実施時]  monitorRunningPrescription(rep 観測) ──► SessionItem.actual*（repLog, 実測露出, stopReason）
```

---

## 2. Domain Types

すべて `src/domain/running/types/` に置き、**Zod スキーマを正、TS 型は `z.infer` で導出**する。[ENGINE-POLICY]

### 2.1 プリミティブ（`primitives.ts`）

```ts
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type Unit = "m" | "s" | "reps" | "sets" | "percent" | "mps" | "contacts" | "h";

/** 閉区間。null は「上限/下限なし」ではなく「値が定義されていない」を意味する。 */
export type Range<U extends Unit = Unit> = { min: number; max: number; unit: U };

/** L-1: "約7–15秒" "おおよそ48h" を型で表す */
export type SoftRange<U extends Unit = Unit> = Range<U> & {
  softness: "HARD" | "SOFT";
  /** SOFT の場合のみ。この区間に入ったら COACH_CONFIRM */
  hysteresis?: Range<U>;
};

export type DataSource =
  | "MEASURED"        // 計測機器・記録
  | "PLANNED"         // 計画値
  | "ESTIMATED"       // 推定モデル（不確実性あり）
  | "RULE_DEFINITION" // 定義上 0 等（例: STRIDE の高速曝露計上なし）
  | "COACH_ENTERED"
  | "UNKNOWN";

export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

/** 値の区間表現。null を 0 として扱わないための型。 */
export type QuantityInterval<U extends Unit = Unit> = {
  lower: number | null;
  upper: number | null;
  unit: U;
  source: DataSource;
  confidence: Confidence;
};
```

- [ENGINE-POLICY] `QuantityInterval` の `lower/upper` が `null` のとき、集計は **0 とみなさない**。§11 の「UNKNOWN 伝播規則」に従う。

### 2.2 列挙型（抜粋。全値を Zod enum で定義）

```ts
export const RUNNING_TRAINING_METHODS = [
  "ACCELERATION", "MAX_VELOCITY", "SPRINT_ENDURANCE_SHORT", "LONG_SPRINT_RACE_SPECIFIC",
  "TEMPO_EXTENSIVE", "TEMPO_INTENSIVE", "RESISTED_SPRINT", "ASSISTED_SPRINT",
  "EVENT_APPROACH_SPEED", "STRIDE",
] as const;                                                     // §3
export type EnvelopeTier = "DEVELOPMENTAL" | "ADVANCED";         // §4
export type AgeBand = "U12" | "U15" | "U18" | "ADULT";            // §4.2
export type MaturityStatus = "PRE" | "CIRCA" | "POST" | "UNKNOWN";
export type MaturityConfidence = "LOW" | "MEDIUM" | "HIGH";
export type TrainingAgeTier = "BEGINNER" | "DEVELOPING" | "TRAINED" | "ADVANCED";
export type TimingMethod = "FAT" | "PHOTO_CELL" | "HAND" | "VIDEO" | "RADAR_LASER" | "UNKNOWN";
export type RecoveryStructure = "FULL" | "INCOMPLETE";
export type ReadinessActionCode =
  | "NO_CHANGE" | "USE_LOWER_BOUND" | "INCREASE_REST"
  | "SWAP_TO_LOWER_LOAD_METHOD" | "CANCEL_HIGH_INTENSITY" | "REQUIRE_COACH_REVIEW";
export type SafetyOutcome = "NONE" | "STOP" | "COACH_REVIEW" | "MEDICAL_EVALUATION_RECOMMENDED";
export type FindingSeverity = "INFO" | "WARN" | "REQUIRE_CONFIRMATION" | "REQUIRE_COACH_REVIEW" | "BLOCK_AUTOGEN" | "BLOCK";
export type PrescriptionConfidence = "HIGH" | "MODERATE" | "LOW" | "POLICY_ONLY";
export type Directness = "DIRECT" | "PARTIAL" | "INDIRECT" | "NOT_APPLICABLE";
export type CompetitionPriority = "TRAINING_MEET" | "NORMAL" | "IMPORTANT" | "PEAK";
export type LoadCategory =
  | "RUNNING_HIGH_INTENSITY" | "RUNNING_LOW_INTENSITY" | "RACE" | "RELAY"
  | "PLYOMETRIC" | "STRENGTH" | "JUMPS" | "HURDLES" | "OTHER";
// TrainingPhase は既存 src/domain/menu/constants.ts の TRAINING_PHASES を再利用
```

### 2.3 強度参照（`intensity.ts`）— 必須の判別共用体

```ts
export type IntensityReference =
  | { kind: "MAX_INTENT" }                                    // 数値%を持たない
  | { kind: "MEASURED_VMAX"; vmax: VelocityEstimate }
  | { kind: "FLY_SPLIT"; flyZoneM: number; mark: TimedMark }
  | { kind: "SAME_DISTANCE_BEST"; distanceM: number; mark: TimedMark }
  | { kind: "RACE_PACE"; event: RaceEvent; targetTimeS: QuantityInterval<"s"> }
  | { kind: "TARGET_SPLIT"; segments: Array<{ distanceM: number; targetS: QuantityInterval<"s"> }> }
  | { kind: "VELOCITY_DECREMENT"; band: "LIGHT" | "MODERATE" | "HEAVY" | "VERY_HEAVY"; measured: boolean }
  | { kind: "RELAXED_SUBMAX" }                                // STRIDE 専用。数値%を持たない
  | { kind: "COACH_DEFINED"; label: string };                // EVENT_APPROACH_SPEED 等

export type VelocityEstimate = {
  valueMps: number;
  lowerMps: number;
  upperMps: number;
  source:
    | "RADAR_LASER" | "FLY_SPLIT_FAT" | "FLY_SPLIT_PHOTO_CELL"
    | "FLY_SPLIT_HAND" | "FLY_SPLIT_VIDEO" | "ESTIMATED_MODEL" | "COACH_ESTIMATE";
  confidence: Confidence;
  measuredAt: IsoDate;
  modelId?: string;   // ESTIMATED_MODEL のときのみ必須
};

export type TimedMark = {
  event: "FLY10" | "FLY20" | "FLY30" | "10m" | "20m" | "30m" | "60m" | "100m" | "150m" | "200m" | "300m" | "400m";
  timeS: number;
  date: IsoDate;
  timing: TimingMethod;
  videoFps?: number;         // timing=VIDEO のとき必須
  wind?: number | null;
  startType?: "BLOCK" | "THREE_POINT" | "STANDING" | "FLYING";
  surface?: "TRACK" | "GRASS" | "ARTIFICIAL" | "ROAD" | "OTHER" | null;
  spikes?: boolean | null;
};
```

- [SOURCE-BACKED] ACCELERATION は `MAX_INTENT`（数値%を持たない）。「98%」は偽精度（Fable H-3、ChatGPT DR）。
- [ENGINE-POLICY] Method ごとに許可する `IntensityReference.kind` を §3.2 の MethodMeta で固定し、Zod refine で検証する。

### 2.4 1 本の構造（`prescription.ts`）— Method ごとに型を固定

```ts
export type RepSpecByMethod = {
  ACCELERATION:              { kind: "DISTANCE"; distanceM: FieldValue<"m"> };
  MAX_VELOCITY:              FlyRep;
  SPRINT_ENDURANCE_SHORT:    { kind: "DURATION"; durationS: FieldValue<"s">; displayDistanceM: QuantityInterval<"m"> };
  LONG_SPRINT_RACE_SPECIFIC: { kind: "DURATION"; durationS: FieldValue<"s">; displayDistanceM: QuantityInterval<"m"> }
                           | { kind: "SPLIT"; segments: SplitSegment[] };
  TEMPO_EXTENSIVE:           { kind: "DISTANCE"; distanceM: FieldValue<"m"> };
  TEMPO_INTENSIVE:           { kind: "DISTANCE"; distanceM: FieldValue<"m"> };
  RESISTED_SPRINT:           { kind: "DISTANCE"; distanceM: FieldValue<"m"> };
  ASSISTED_SPRINT:           FlyRep;
  EVENT_APPROACH_SPEED:      { kind: "ATTEMPTS"; approach: "SHORT" | "FULL"; approachDistanceM: FieldValue<"m"> | null };
  STRIDE:                    { kind: "DISTANCE"; distanceM: FieldValue<"m"> };
};

/** §10 の必須分離 */
export type FlyRep = {
  kind: "FLY";
  buildUpDistanceM: FieldValue<"m">;
  flyZoneDistanceM: FieldValue<"m">;
  decelerationDistanceM: number;                        // 安全確保。露出に計上しない
  totalRunningDistanceM: number;                        // 導出値 = build + fly + decel
  plannedHighSpeedExposureM: QuantityInterval<"m">;     // §11.2
};

export type SplitSegment = { distanceM: number; restAfterS: FieldValue<"s"> | null };

/** 数値フィールドは必ず3層 + 根拠を持つ */
export type FieldValue<U extends Unit> = {
  value: number;
  unit: U;
  recommended: Range<U>;
  coachEditable: Range<U>;
  hardSafety: Range<U> | null;        // null = 出典のある安全上限が無い
  position: "LOWER_BOUND" | "LOWER_HALF" | "MIDDLE" | "UPPER_HALF";
  evidenceIds: EvidenceId[];
  editedBy?: "ENGINE" | "COACH" | "COACH_OVERRIDE";
};
```

### 2.5 出力（`RunningPrescription`）

```ts
export type RunningPrescription<M extends RunningTrainingMethod = RunningTrainingMethod> = {
  schemaVersion: 1;
  method: M;
  templateId: TemplateIdByMethod[M];
  recoveryStructure: M extends "LONG_SPRINT_RACE_SPECIFIC" ? RecoveryStructure : null;
  tier: EnvelopeTier;
  sets: FieldValue<"sets">;
  repsPerSet: FieldValue<"reps">;
  rep: RepSpecByMethod[M];
  rest: RestPlan;                                   // §9.4
  intensity: { reference: IntensityReference; target: QuantityInterval<"percent"> | QuantityInterval<"s"> | null };
  exposure: {
    totalRunningDistanceM: QuantityInterval<"m">;
    plannedHighSpeedExposureM: QuantityInterval<"m">;
    nearMaxSprintVolumeM: QuantityInterval<"m">;
  };
  stopPolicyId: StopPolicyId;                       // §10
  confidence: { prescription: PrescriptionConfidence; directness: Directness; inputData: Confidence };
  readinessApplied: ReadinessActionCode[];
  findings: Finding[];
  rationale: RationaleLine[];                       // コード + パラメータ。表示は rationale/ で日本語化
  ruleSet: { version: string; contentHash: string; status: "DRAFT" | "ACTIVE" | "RETIRED" };
  generatedBy: GenerationRecord;                    // §18
};

export type Finding = {
  code: string;                 // 例 "AGG_NEAR_MAX_OVER_RECOMMENDED"
  severity: FindingSeverity;
  scope: "ITEM" | "SESSION" | "WEEK";
  metric?: string;
  value?: QuantityInterval;
  limit?: Range;
  evidenceIds: EvidenceId[];
};
```

- [ENGINE-POLICY] v2 項目では **`sets` と `repsPerSet` の両方が必須・非 null**。「4set×60m = 4本」のような legacy の曖昧さ（監査 C-1）を型で排除する。
- **[R9 errata] `RunningPrescription.loadSnapshot: { loadClass; weeklyLoadCategory }` を追加する。** plan に使った RuleSet の
  MethodMeta（§3.2）から2項目だけをデータとしてコピーする（Method 名から TS で再定義しない。他の MethodMeta はコピーしない）。
  §12.2 の週次文脈（SessionItem.loadCategory と LoadEvent.intensityTag）をセッション作成・履歴変換時に RuleSet を読まずに
  再現するための metadata であり、量・強度・rest・露出・findings・rationale には影響しない。
  - schemaVersion は 1 のまま。`RunningPrescriptionSchema` 上は **backward-compatible な optional**（R8 までの処方 JSON に
    無いため、読込では欠落を許す）。
  - `planRunningPrescription` の成功結果は必ず持つ（`validatePrescription` が MethodMeta との一致を検証）。
  - R9 以降に新規保存する RUNNING_V2 MenuItem では **必須**（永続化の書込み検証が要求し、repository は RuleSet から補完しない）。
- **[R4 errata]**（§2.4 の型。`types/prescription.ts` と Zod が正。R4 pre-commit 補正後の確定形）:
  - `FieldValue` は**位置と値の由来を分離**する（`editedBy` は `origin` に統合して廃止）:
    ```ts
    type RangePosition = "LOWER_BOUND" | "LOWER_HALF" | "MIDDLE" | "UPPER_HALF";   // §7.3 の位置のみ
    type ValueOrigin =
      | "ENGINE_POSITIONED"   // recommended 内の position に置いた値（position 必須・recommended 内）
      | "SOLVER_DERIVED"      // §7.3 ②③ の解決順で決まった回数（recommended 内）
      | "TEMPLATE_FIXED"      // SessionTemplate.fixedDistanceField による固定値（recommended 外は Finding）
      | "STRUCTURAL_FIXED"    // schemaVersion=1 の構造正規化規則による値（§7.3 R4 errata の sets=1 等）
      | "COACH"               // コーチ入力（coachEditable 内）
      | "COACH_OVERRIDE";     // CoachOverride（coachEditable / hardSafety 外もありうる）
    type FieldValue<U> = { value; unit; recommended: Range<U> | null; coachEditable; hardSafety;
                           position: RangePosition | null; origin: ValueOrigin; evidenceIds };
    ```
    Zod refine: `position != null` ⇔ `origin = ENGINE_POSITIONED`／ENGINE_POSITIONED・SOLVER_DERIVED は recommended 内／
    `recommended = null`（§7.2 の手動専用セル）の値は COACH / COACH_OVERRIDE だけ（推奨範囲を捏造しない）／
    coachEditable 外・hardSafety 外は COACH_OVERRIDE だけ（対応する CoachOverride の存在は planning step 13 で照合）。
    rest の「MIDDLE 以上」、confidence の位置上限、固定値、手動値を同じ enum で比較しない。
  - `FlyRep.decelerationDistanceM` / `totalRunningDistanceM` は `number | null`（両方同時に null）。
    `decelerationM` セルを持たない ASSISTED_SPRINT で 0 を入れて「減速なし」と偽装しないため。
  - `AttemptsRepSpec.approachDistanceM` は `FieldValue<"m">` ではなく
    `{ value: number; unit: "m"; source: "COACH_ENTERED" } | null`（§7.4 R2 errata の「EnvelopeCell ではない手入力値」。
    recommended / coachEditable を持たせない。plausibility は `PlausibilityRule.inputTarget = COACH_EDIT_APPROACH_DISTANCE_M` の行（≤60m で REQUIRE_CONFIRMATION））。
  - `RunningPrescription.monitoringSnapshot: { stopPolicy: StopPolicySnapshot; timingTolerances: TimingToleranceSnapshot[]; vdecClassificationPolicy?: VdecClassificationPolicySnapshot }` を追加
    （§17.1 不変条件5）。plan 時点の RuleSet から、選ばれた StopPolicy の行と**全 TimingMethod** の TimingTolerance の行を
    **データとしてコピー**する（RuleSet object への参照ではない。snapshot の schema は schemaVersion=1 の一部として strict に独立定義）。
    `stopPolicyId` は検索・表示用に残し、`monitoringSnapshot.stopPolicy.id` と一致しなければならない。
  - `RunningPrescription.confidence.inputData` は `HIGH | MEDIUM | LOW | NONE | NOT_REQUIRED`（§5.4 R4 errata）。
  - `runningPrescriptionSchema` は RuleSet を見ずに決まる構造（MAX_INTENT / RELAXED_SUBMAX / FLY_SPLIT と MAX_VELOCITY の
    target=null、snapshot の stopPolicy id 一致）を refine する。RuleSet に依存する整合（reference kind の MethodMeta 許可、
    Envelope セルとの範囲一致、stopPolicy と recoveryStructure、snapshot が plan 時点の RuleSet 行と一致、構造正規化規則、
    エンジン rest の位置、fixedDistanceField / approachType との一致）は `planning/validatePrescription.ts` が検証する（Zod に偽装しない）。

---

## 3. Method / SessionTemplate

### 3.1 canonical Method（10種・確定）

| Method | 目的（内部定義） | 主単位 | 高強度扱い | 既定で自動生成 | advancedOnly | 判断 |
| --- | --- | --- | --- | --- | --- | --- |
| `ACCELERATION` | 静止・低速からの速度立ち上げ | 距離 | ✅ | ✅ | — | [SOURCE-BACKED] Haugen 2019 / UKA 分類 |
| `MAX_VELOCITY` | 最高速度とその技術への曝露（build-up + fly） | 距離（build/fly分離） | ✅ | ✅ | — | [SOURCE-BACKED] |
| `SPRINT_ENDURANCE_SHORT` | 7–15秒程度の近最大速度の維持（完全回復） | **時間** | ✅ | 条件付き §4.5 | — | [SOURCE-BACKED] 時間を一次軸にするのは Fable C-4 に従う |
| `LONG_SPRINT_RACE_SPECIFIC` | 15秒超の 200/400/400H 特異的耐性 | 時間 or 分割 | ✅ | 条件付き §4.5 | INCOMPLETE は実質 ADVANCED 限定 | [SOURCE-BACKED] 分類／境界は [OPEN] |
| `TEMPO_EXTENSIVE` | 低〜中強度の走容量・リズム | 距離（総量） | ❌ | ✅ | — | [SOURCE-BACKED] |
| `TEMPO_INTENSIVE` | 中間強度の不完全回復走 | 距離 | ✅ | **❌（enabledByDefault=false）** | template 単位 | [ENGINE-POLICY]（ChatGPT DR 推奨・定義不統一） |
| `RESISTED_SPRINT` | 抵抗下の加速（sled/hill） | 距離 | ✅ | 条件付き | heavy は §4.5 | [SOURCE-BACKED] vdec 分類 |
| `ASSISTED_SPRINT` | 通常 Vmax 超の曝露 | 距離（build/fly分離） | ✅ | **❌（常に）** | **✅** | [SOURCE-BACKED] 長期効果の証拠が限定的 → advanced-only は [ENGINE-POLICY] |
| `EVENT_APPROACH_SPEED` | ハードル/跳躍助走の速度・再現性 | 試技数 | ✅（FULL 助走） | coach-configured | — | [ENGINE-POLICY]（普遍 range を作らない） |
| `STRIDE` | W-up・リズム・リラックス・低疲労曝露 | 距離 | ❌ | ✅ | — | [SOURCE-BACKED] JAAF ウインドスプリント（Claude DR 経由）＋ Fable H-1 |

- `SUBMAX_SPEED_ENDURANCE` は **canonical にしない**。`TEMPO_INTENSIVE` 配下の template `TI_VITTORI_SE` とする。[ENGINE-POLICY]（Fable C-5 案A）
- Flying Sprint / Block Start / Hill / Race Pace / Special Endurance I・II / Overspeed / Hurdle rhythm は Method ではなく template または intensityReference。[SOURCE-BACKED 方針: ChatGPT/Perplexity/Claude DR が一致]

### 3.2 MethodMeta（ルールセットに保存）

```ts
export type MethodMeta<M extends RunningTrainingMethod> = {
  method: M;
  loadClass: "HIGH_NEURAL" | "HIGH_METABOLIC" | "MODERATE" | "LOW";
  weeklyLoadCategory: LoadCategory;               // §12
  primaryDoseUnit: "DISTANCE" | "DURATION" | "ATTEMPTS";
  allowedIntensityReferences: IntensityReference["kind"][];
  intensityFallback: IntensityReference["kind"] | null;   // データ欠損時。null = 欠損時は不適格
  highSpeedExposureModel: "NONE" | "FLY_ZONE" | "DISTANCE_MINUS_ACCEL_INTERVAL" | "WHOLE_REP";
  requiresRecoveryStructure: boolean;             // LONG のみ true
  enabledByDefault: boolean;
  advancedOnly: boolean;
  stopPolicyIds: StopPolicyId[];                  // §10
};
```

| Method | loadClass | allowedIntensityReferences（先頭が優先） | fallback | exposure model |
| --- | --- | --- | --- | --- |
| ACCELERATION | HIGH_NEURAL | MAX_INTENT | — | DISTANCE_MINUS_ACCEL_INTERVAL |
| MAX_VELOCITY | HIGH_NEURAL | MEASURED_VMAX, FLY_SPLIT, MAX_INTENT | MAX_INTENT（confidence LOW） | FLY_ZONE（+ build-up 後半の区間推定） |
| SPRINT_ENDURANCE_SHORT | HIGH_METABOLIC | SAME_DISTANCE_BEST, MEASURED_VMAX, MAX_INTENT | MAX_INTENT（LOW） | WHOLE_REP（区間推定） |
| LONG_SPRINT_RACE_SPECIFIC | HIGH_METABOLIC | RACE_PACE, TARGET_SPLIT, SAME_DISTANCE_BEST | **null（欠損時不適格）** | DISTANCE_MINUS_ACCEL_INTERVAL |

**[R10-B4A.2] コーチ手入力の強度基準（Coach manual reference）**

- **入力 contract**: `CoachManualReferenceInput`（`planning/coachReference.ts`）。R10 では `{ kind: "TARGET_SPLIT"; segments: Array<{ distanceM; targetTimeS }> }` のみ
  （RACE_PACE の入力 UI は R10 では追加しない）。`toCoachReferenceInput()` が正式な `IntensityReference` へ正規化し、
  `targetS` は **`lower = upper = 入力値`**（中央値・推定値を作らない）、`source = "COACH_ENTERED"`、confidence は既存慣習の `MEDIUM`。
- **actor**: `PlanRequest.coachReference` は **COACH actor だけ**が持てる（AI / SYSTEM は `planRequestSchema` が拒否。§18）。
- **Method 互換性**: 使えるかどうかは RuleSet の `MethodMeta.allowedIntensityReferences` が source of truth（Method 名の TS 分岐で判定しない）。
  許可されていない Method に渡されたら `COACH_REFERENCE_INVALID`（BLOCK）で**明示的に拒否**し、参照を無視して処方を作らない。
- **優先順位**: 既存実装どおり `allowedIntensityReferences` の並び順で解決する（rs-2026.09.0 では TARGET_SPLIT を許可するどの Method でも、
  実測参照が TARGET_SPLIT より先に並んでいないため、明示的なコーチ入力が黙って無視されることはない）。
- **記録に変換しない**: TimedMark / PB / Vmax / SAME_DISTANCE_BEST へ変換せず、コーチの予定値は予定値のまま保持する。
- **GROUP**: `intensity.target`（個別の目標タイム）は従来どおり ATHLETE のときだけ生成する。GROUP では null のままで、
  `intensity.reference` にコーチが入力した値を exact な snapshot として保存するだけ（エンジンが GROUP へ個別目標を作ったのではない）。
- **confidence**: コーチ入力の基準は「入力された計画値」であり performance evidence ではない。Subject の data confidence 上限（GROUP は LOW）・
  `EnvelopeTier`・`prescriptionConfidence` / `directness` をこの入力を理由に引き上げない。
- **永続化**: `prescriptionJson` の `intensity.reference` に保存する（新しい列・migration は不要）。`planningControls` へ二重保存しない。
  Provenance は `inputsDigest.referenceKinds` に `TARGET_SPLIT` を記録するだけで、区間の数値を複製しない（コーチ入力であることは
  `source = COACH_ENTERED` と `generatedBy.createdByCoach` で分かる）。
- **編集・再計算**: 通常の数値編集では保存済みの参照を exact に維持する。`editRunningItemAction` は `coachReferenceJson` で基準の明示更新を受け取り、
  新しい値で再計画する（基準の変更を `coachEdits`（EnvelopeField の編集履歴）へ偽装しない）。現行 RuleSet での再計算では保存済みの
  参照を**計画入力として再利用**してよい（override とは違い、RuleSet の方針を破る例外承認ではない）。新しい RuleSet がその kind を
  許可しなくなった場合は fail closed（別の参照へ黙って変換しない）。override 後の再計画でも参照を維持する。
- **R10 UI**: LONG FULL の追加導線は目標スプリットの入力を含む（`components/running/target-split-editor.tsx`。距離・タイムを自動補完しない）。
| TEMPO_EXTENSIVE | LOW | MEASURED_VMAX, SAME_DISTANCE_BEST | RELAXED_SUBMAX（LOW・数値目標なし） | NONE |
| TEMPO_INTENSIVE | MODERATE | MEASURED_VMAX, SAME_DISTANCE_BEST | **null** | NONE（≥95% 実測時のみ計上） |
| RESISTED_SPRINT | HIGH_NEURAL | VELOCITY_DECREMENT, MAX_INTENT(hill) | MAX_INTENT（heavy は不適格） | NONE（無抵抗 HSR と別） |
| ASSISTED_SPRINT | HIGH_NEURAL | MEASURED_VMAX | **null** | FLY_ZONE |
| EVENT_APPROACH_SPEED | HIGH_NEURAL | COACH_DEFINED, TARGET_SPLIT | COACH_DEFINED | DISTANCE_MINUS_ACCEL_INTERVAL |
| STRIDE | LOW | RELAXED_SUBMAX | — | NONE（RULE_DEFINITION で 0） |

判断: 表全体 [ENGINE-POLICY]。「ACCELERATION=MAX_INTENT」「TEMPO=Vmax/同距離比」「MV=Vmax/fly」は [SOURCE-BACKED]（ChatGPT/Perplexity DR）。

### 3.3 SessionTemplate の型分離（混同をコンパイルエラーにする）

```ts
export type TemplateIdByMethod = {
  ACCELERATION: "ACC_BLOCK_10" | "ACC_BLOCK_20" | "ACC_BLOCK_30" | "ACC_BLOCK_40"
              | "ACC_CROUCH_20" | "ACC_STANDING_20" | "ACC_FALLING_10";
  MAX_VELOCITY: "MV_FLY10" | "MV_FLY20" | "MV_FLY30";
  SPRINT_ENDURANCE_SHORT: "SES_80" | "SES_100" | "SES_120" | "SES_150";
  LONG_SPRINT_RACE_SPECIFIC:
      "LSR_SPECIAL_ENDURANCE_I" | "LSR_SPECIAL_ENDURANCE_II" | "LSR_RACE_MODEL"     // FULL
    | "LSR_300_PLUS_100" | "LSR_200_PLUS_200" | "LSR_BROKEN_400";                    // INCOMPLETE
  TEMPO_EXTENSIVE: "TE_100" | "TE_200" | "TE_300";
  TEMPO_INTENSIVE: "TI_VITTORI_SE" | "TI_COACH_DEFINED";
  RESISTED_SPRINT: "RS_SLED_LIGHT" | "RS_SLED_MODERATE" | "RS_SLED_HEAVY" | "RS_HILL_SHORT";
  ASSISTED_SPRINT: "AS_TOWING" | "AS_DOWNHILL";
  EVENT_APPROACH_SPEED: "EA_HURDLE_START_TO_H1" | "EA_HURDLE_RHYTHM" | "EA_JUMP_SHORT_APPROACH" | "EA_JUMP_FULL_APPROACH";
  STRIDE: "ST_WARMUP" | "ST_RELAXED" | "ST_BETWEEN_SETS";
};

export type SessionTemplateId = TemplateIdByMethod[RunningTrainingMethod];

/** method と templateId の組み合わせを型で拘束（"MAX_VELOCITY" + "ACC_BLOCK_20" はコンパイル不可） */
export type RunningSelection = {
  [M in RunningTrainingMethod]: { method: M; templateId: TemplateIdByMethod[M] }
}[RunningTrainingMethod];

export type SessionTemplate<M extends RunningTrainingMethod> = {
  id: TemplateIdByMethod[M];
  method: M;
  labelJa: string;                     // 例 "フライ20m"
  coachingAliases: string[];           // 例 ["Special Endurance I", "SE1"]
  recoveryStructure: M extends "LONG_SPRINT_RACE_SPECIFIC" ? RecoveryStructure : null;
  startType?: "BLOCK" | "THREE_POINT" | "STANDING" | "FALLING" | "FLYING";
  displayDistanceM?: number;           // SES/LSR は表示専用（一次軸は時間）
  enabledByDefault: boolean;
  advancedOnly: boolean;
  primaryEvents?: RaceEvent[];         // 例 LSR は ["200m","400m","400mH"]
};
```

- [ENGINE-POLICY] **SessionTemplate は DB モデルにしない。ルールセット JSON 内の domain 定数**とする。
  - 理由: template の envelope は研究更新で変わるため、ルールセットと同じ版管理に載せる必要がある／コーチ独自 template の要望は現時点で無い（§24 OPEN-11）。
- [ENGINE-POLICY] 識別子の名前空間を分ける。template id は必ず接頭辞付き（`ACC_` `MV_` …）で、Method 値と文字列が重ならないことをテストで保証（R2）。
- LSR の FULL / INCOMPLETE の割当は [ENGINE-POLICY]（Claude/ChatGPT DR の「SE=完全回復、split run=不完全回復」説明に基づく）。Special Endurance I/II の距離境界は [OPEN]（DR 間で 150–300/300–600m、15–45/45–90秒等が不一致・比較研究なし）。

---

## 4. Population & Athlete Context

### 4.1 Subject（処方対象）

```ts
export type Subject =
  | { kind: "GROUP"; profile: GroupProfile }       // v2 初期実装
  | { kind: "ATHLETE"; profile: AthleteProfile };  // 型のみ（永続化は §24 OPEN-01）

export type AthleteProfile = {
  birthDate: IsoDate | null;
  ageBandOverride?: AgeBand;             // 生年月日が無い場合のみ
  schoolGrade?: string | null;           // 表示・運用のみ。maturity 推定に使わない
  sexForNorms?: "MALE" | "FEMALE" | null;   // 記録の解釈用。volume に使わない
  primaryEvent: RaceEvent | "HURDLES" | "LJ" | "TJ" | "HJ" | "PV" | "OTHER";
  maturity: MaturityAssessment;
  trainingAge: TrainingAgeInput;
  marks: TimedMark[];
  vmax?: VelocityEstimate | null;
  allowAdvancedMethods: boolean;         // コーチが明示的に許可した場合のみ true
};

export type GroupProfile = {
  label: string;
  members: Array<Pick<AthleteProfile, "birthDate" | "ageBandOverride" | "maturity" | "trainingAge" | "primaryEvent">>;
  memberCountHint?: number;              // L-3: rest 実現可能性の表示に使う
  availableMinutes?: number | null;
  allowAdvancedMethods: boolean;
};
```

- [ENGINE-POLICY] GROUP の解決規則（**最も制約の強い条件に合わせる**）:
  - ageBand = 最年少、trainingAge = 最低 tier、maturity = メンバーに現れる全カテゴリの制約を**積集合**で適用。
  - 個人記録（marks/vmax）は使わない → 参照依存 Method の prescriptionConfidence は最大 LOW、個人目標タイムは出さない。
  - members が空 → ageBand/maturity/trainingAge すべて UNKNOWN 扱い（§4.4 の保守既定）。
- **[R3 implementation note]** `ResolvedAgeBand = AgeBand | "UNKNOWN"` は R3 context 層だけで使う
  **観測状態の型**であり、canonical な `AgeBand`（U12/U15/U18/ADULT）や Evidence の
  population enum を変更しない。members が空の GROUP（または birthDate・ageBandOverride が
  無い ATHLETE）は出力上 `ageBand = "UNKNOWN"` のまま保持し、特定の年齢帯（U12 等）へ偽装しない。
  ただし年齢帯に依存する制約（§8.2 の ConstraintRule）だけは「全 AgeBand で許されるものの積集合」
  として評価する（＝どの年齢帯であっても安全な側に倒す）。maturity は EFFECTIVE_UNKNOWN、
  trainingAge は未知（effective tier = BEGINNER）、EnvelopeTier は DEVELOPMENTAL。

### 4.2 ageBand（暦年齢）— maturation と分離

| ageBand | 暦年齢（処方日時点） | 用途 |
| --- | --- | --- |
| `U12` | 12歳未満 | 安全制約・競技団体ガイドライン（§8.4） |
| `U15` | 12–14歳 | 同上（中学期の運用上限を含む） |
| `U18` | 15–17歳 | 同上 |
| `ADULT` | 18歳以上 | maturity を POST/HIGH として扱う |

- [SOURCE-BACKED] 暦年齢と生物学的成熟を同一視しない（Moran/Malina/IOC consensus を ChatGPT・Claude・Perplexity DR が報告）。
- [ENGINE-POLICY] 年齢帯の境界（12/15/18）は日本の学校段階に合わせた運用値。
- [ENGINE-POLICY] `ADULT` の maturity 自動 POST 化。18–19歳の晩熟例は [OPEN-05]。
- [ENGINE-POLICY] `schoolGrade` から maturity を**自動確定しない**（DR 全件一致の禁止事項）。

### 4.3 Maturity

```ts
export type MaturityAssessment = {
  status: MaturityStatus;
  confidence: MaturityConfidence;
  method: "NONE" | "COACH_OBSERVATION" | "PARENT_REPORT" | "GROWTH_VELOCITY" | "MATURITY_OFFSET_EQUATION";
  assessedAt: IsoDate | null;
  heightHistory?: Array<{ date: IsoDate; heightCm: number }>;   // 将来利用。v2 では速度計算のみ
  equation?: { id: "MIRWALD_2002" | "OTHER"; offsetYears: number; se?: number } | null;
};
```

- [ENGINE-POLICY] 医学的診断機能にしない。UI 文言は「成長段階の目安（コーチ判断）」とし、思春期評価（二次性徴）を**入力項目にしない**（Fable M-1）。
- [CHECK_ONLY] 年間成長速度の急増（Claude DR が narrative review の 7.2cm/年を報告）→ **`rapidGrowthFlag`**。
  - `rapidGrowthFlag` は male academy football の risk marker をコーチ確認へ渡すためだけの provisional check であり、hard stop、eligibility cutoff、female/general track threshold、または自動的な maturity/tier 変更ではない。
  - **[R3 implementation policy]** 成長速度の算出（初版 ENGINE-POLICY・provisional。医学的診断値ではない）:
    1. `asOf` より未来の点を除外し、F1の date-aware selector が成長計算に使う同じ端点を確定する。端点の値で採否を変えない。
       端点が§8.5のreview範囲を外れる場合はF1で計画をBLOCKし、成長速度計算には別の端点を代用しない。未来点・未選択の極端値はDATA_QUALITYとして隔離する。
    2. 残った有効点が **2点未満**なら算出しない（rapidGrowthFlag を無理に確定しない）。
    3. 有効点の **最古点と最新点の2点だけ**を使う（回帰・平滑化・区間の重み付けはしない）。
    4. 2点の間隔が **6か月以上**（実装上は 182 日以上。日付は date-only の通日番号差で計算し、
       タイムゾーンに依存しない）でなければ算出しない。
    5. 年換算成長速度 = (最新身長 − 最古身長) ÷ 日数差 × 365。
    6. **`> 7.2` cm/年のときだけ** `rapidGrowthFlag = true`（`>=` ではない）。
    - `method = GROWTH_VELOCITY` なのに 2〜4 の条件を満たせない場合は、confidence を MEDIUM へ
      上げず、`method = NONE` と同様に status = UNKNOWN / confidence = LOW として扱う。
- [ENGINE-POLICY] Mirwald 等の推定式は v2 初期ルールセットに**実装しない**（係数を一次資料で未照合）。入力として offset を受け取る場合も confidence 最大 MEDIUM。
- [ENGINE-POLICY] `maturityConfidence` の実効値: `method=NONE` → status を UNKNOWN に強制、`COACH_OBSERVATION/PARENT_REPORT` → 最大 MEDIUM、`GROWTH_VELOCITY`（2点以上・6か月以上間隔）→ 最大 MEDIUM、`MATURITY_OFFSET_EQUATION` → 最大 MEDIUM。HIGH は ageBand=ADULT のみ。

### 4.4 maturity UNKNOWN / LOW の既定挙動（Fable C-1 対応）

- 原則: **UNKNOWN/LOW を ADULT 扱いしない。ただし PRE と完全同一にもしない。** [ENGINE-POLICY]
- 実効カテゴリ: `status=UNKNOWN` または `confidence=LOW` → **`EFFECTIVE_UNKNOWN`**（`status=POST & confidence=LOW` も含む）。
- **[R3 errata]** 上の1文を額面どおり「confidence=LOW なら常に EFFECTIVE_UNKNOWN」と読むと、
  `PRE + LOW` が EFFECTIVE_UNKNOWN になり、下表の SPRINT_ENDURANCE_SHORT が
  「不適格（override 可）」→「手動+REVIEW」へ**緩む**（confidence が下がっただけで eligibility が
  緩和される逆転）。これは安全側の原則に反するため、実効カテゴリは次のとおり確定する
  （上から順に最初に該当したもの）:

  | 条件 | 実効カテゴリ |
  | --- | --- |
  | normalized status = PRE | PRE（confidence に関わらず） |
  | normalized status = CIRCA | CIRCA（confidence に関わらず） |
  | normalized status = UNKNOWN | EFFECTIVE_UNKNOWN |
  | normalized status = POST かつ confidence = LOW | EFFECTIVE_UNKNOWN |
  | normalized status = POST かつ confidence ≥ MEDIUM | POST |

  - **LOW confidence は、既知の PRE / CIRCA を EFFECTIVE_UNKNOWN へ変換しない。** LOW は
    eligibility を緩める方向に働いてはならない（confidence を下げたときの結果は、同等か
    より制約的でなければならない。R3 のテストで 64 セル全件について検証する）。
  - normalized status は §4.3 の規則で先に決まる（`method=NONE` や、履歴条件を満たさない
    `GROWTH_VELOCITY` は status=UNKNOWN に強制される）。表のヘッダー「POST（≥MEDIUM）」の
    confidence 条件は POST 列にだけ適用される。

| Method / Template | PRE | EFFECTIVE_UNKNOWN | CIRCA | POST（≥MEDIUM） |
| --- | --- | --- | --- | --- |
| ACCELERATION（≤20m template） | 自動 ✅ | 自動 ✅ | 自動 ✅ | 自動 ✅ |
| ACCELERATION（30–40m template） | 手動+REVIEW | 手動+REVIEW | 手動+REVIEW | 自動 ✅（tier 依存） |
| MAX_VELOCITY MV_FLY10 | 自動 ✅（reps≤3） | 自動 ✅（reps≤3） | 自動 ✅（reps≤3） | 自動 ✅ |
| MAX_VELOCITY MV_FLY20/30 | 手動+REVIEW | 手動+REVIEW | 手動+REVIEW | 自動 ✅（tier 依存） |
| STRIDE（全 template） | 自動 ✅ | 自動 ✅ | 自動 ✅ | 自動 ✅ |
| TEMPO_EXTENSIVE | 自動（lower half） | 自動（lower half） | 自動（lower half） | 自動 ✅ |
| SPRINT_ENDURANCE_SHORT | **不適格（override 可）** | 手動+REVIEW | 手動+REVIEW | 条件付き自動 §4.5 |
| LONG FULL | **不適格（override 不可）** | 不適格（override 可） | 不適格（override 可） | 条件付き自動 §4.5 |
| LONG INCOMPLETE | 不適格（override 不可） | 不適格（override 不可） | 不適格（override 不可） | POST+ADVANCED のみ自動 |
| TEMPO_INTENSIVE（全） | 不適格（override 可） | 手動+REVIEW | 手動+REVIEW | 手動（VITTORI は advancedOnly） |
| RESISTED LIGHT / HILL_SHORT | 手動+REVIEW | 手動+REVIEW | 手動+REVIEW | 自動 ✅ |
| RESISTED MODERATE | 不適格（override 可） | 手動+REVIEW | 手動+REVIEW | 自動（ADVANCED のみ） |
| RESISTED HEAVY | 不適格（override 不可） | **不適格（override 不可）** | 不適格（override 不可） | 手動（ADVANCED + 実測 vdec） |
| ASSISTED（全） | 不適格（override 不可） | 不適格（override 不可） | 不適格（override 不可） | advancedOnly §4.5 |
| EVENT_APPROACH SHORT | 手動 | 手動 | 手動 | 手動 |
| EVENT_APPROACH FULL | 手動+REVIEW | 手動+REVIEW | 手動+REVIEW | 手動 |

- 表の区分定義: 「自動」= AI/エンジンが自動生成してよい。「手動」= コーチが明示選択した場合のみ。「+REVIEW」= `REQUIRE_COACH_REVIEW` Finding 付き。「不適格」= 選択不可、override の可否は §8.3。
- **[R4 errata]** 表の括弧内の条件（「reps≤3」「lower half」「ADVANCED のみ自動」「実測 vdec 必須」、§4.5 の条件付き自動）は、
  RuleSet の `EligibilityRule.conditionNote`（人間向けの説明）ではなく、構造化フィールドで保持する:
  `conditions`（`requiresEnvelopeTier` / `requiresTrainingAgeTiers` / `requiresPrimaryEvents` / `requiresAllowAdvancedMethods` /
  `requiresMeasuredVelocityDecrement` / `requiresVmaxConfidenceAtLeast` と、満たさないときの `whenUnmet` =
  `MANUAL_WITH_REVIEW`（AUTO 行）/ `INELIGIBLE_NON_OVERRIDABLE`（MANUAL 行））と `autoGenerationLimits`
  （`maxTotalReps` / `positionCap`。エンジンが置く値の上限）。phase に依存する条件は既存の `requiresPhaseEvaluation`。
  **`conditionNote` は説明専用**で、planning は conditionNote・ruleId・templateId の文字列を読まずに同じ判断をする
  （conditionNote を全件書き換えても結果が変わらないことをテストで保証）。
  SES POST の「tier=ADVANCED、または (POST & tier≥DEVELOPING & phase≠TRANSITION)」は OR を含む phase 依存条件のため
  R4 では `requiresPhaseEvaluation=true` のみで表し（AUTO にしない）、構造化は R7 で phase を接続するときに行う。
- **[R4 implementation note]** この表の「自動」/ 条件付き自動は population / context 上の自動生成**許可**を意味するだけで、後段の
  Evidence / prescriptionConfidence gate（§5.5: LOW・POLICY_ONLY × HIGH_METABOLIC）により AI / SYSTEM の自動生成が最終的に BLOCK される場合がある。
  現行 DRAFT の LONG_SPRINT_RACE_SPECIFIC は使用 Envelope セルの Evidence がすべて ENGINE_POLICY で POLICY_ONLY になるため AI / SYSTEM では自動生成されないが、
  これは意図した安全側の挙動であり（COACH の手動計画は eligibility が許せば可能）、eligibility の不具合として RuleSet の数値を広げない。
- 判断: 表全体 [ENGINE-POLICY]。方向性（youth で LONG/ASSISTED/heavy resisted を外す、短い加速・流し・短い fly を候補にする）は [SOURCE-BACKED]（Claude・ChatGPT・Perplexity DR と Fable C-1 が一致）。個々の境界（20m、reps≤3 等）は provisional。

### 4.5 trainingAge と Tier

```ts
export type TrainingAgeInput = {
  structuredSprintYears: number | null;     // 構造化された短距離系トレーニング年数
  coachAssignedTier?: TrainingAgeTier | null;
};
```

- 導出（`coachAssignedTier` が無い場合）[ENGINE-POLICY・provisional]:
  - `null` → `BEGINNER`（データ欠損を上級扱いしない）
  - `< 1` → BEGINNER / `1–<3` → DEVELOPING / `≥3` → TRAINED
  - **`ADVANCED` はコーチの明示割当でのみ付与**（年数からは導出しない）
- **EnvelopeTier = ADVANCED の条件（すべて満たす）** [ENGINE-POLICY]:
  1. maturity が `POST` かつ実効 confidence ≥ MEDIUM（ADULT は自動充足）
  2. trainingAge tier ∈ {TRAINED, ADVANCED}
  3. 成長速度の CHECK_ONLY flag は tier eligibility を変更しない
- それ以外はすべて **DEVELOPMENTAL**。成人初心者も DEVELOPMENTAL。[SOURCE-BACKED 方針]（ChatGPT DR「post-PHV ≠ advanced athlete」、Fable M-2）
- 「条件付き自動」（§4.4）の条件 [ENGINE-POLICY]:
  - SPRINT_ENDURANCE_SHORT: tier=ADVANCED、または (POST & tier=DEVELOPING 以上 & phase≠TRANSITION)
  - LONG FULL: POST & tier ∈ {TRAINED, ADVANCED} & primaryEvent ∈ {200m, 400m, 400mH}
  - LONG INCOMPLETE: **POST & EnvelopeTier=ADVANCED** & primaryEvent ∈ {200m, 400m, 400mH}（Fable C-7 / 要件§14）
  - ASSISTED: EnvelopeTier=ADVANCED & `allowAdvancedMethods=true` & `vmax.confidence ≥ MEDIUM` → それでも**自動生成はしない**（手動のみ）

### 4.6 Performance data と Vmax 欠損

- [SOURCE-BACKED] 入力の有用性順（fly/実測 Vmax > 30m/split > 種目 PB > 100m PB）は DR 一致。ただし**実際にあるデータは 100m PB（手動/公式）が主**（Fable H-5）。
- `ReferenceResolution`（Method ごとに解決）[ENGINE-POLICY]:

| 利用可能データ | MAX_VELOCITY | TEMPO_EXTENSIVE | SPRINT_ENDURANCE_SHORT | LONG |
| --- | --- | --- | --- | --- |
| RADAR/PHOTO/FAT の fly（≤180日※） | MEASURED_VMAX / FLY_SPLIT, conf HIGH | %Vmax 目標, conf HIGH | 同距離 best 優先 | — |
| HAND の fly | FLY_SPLIT, conf LOW | %Vmax 目標, conf LOW | — | — |
| 同距離 best（任意計時） | — | SAME_DISTANCE_BEST, conf は計時法依存 | SAME_DISTANCE_BEST | SAME_DISTANCE_BEST |
| 100m PB のみ | MAX_INTENT, conf LOW | **RELAXED_SUBMAX fallback（数値目標なし）**, conf LOW | MAX_INTENT, conf LOW | **不適格**（RACE_PACE 目標を作れない。コーチが TARGET_SPLIT を手入力すれば適格） |
| 何も無い | MAX_INTENT, conf LOW | RELAXED_SUBMAX, conf LOW | MAX_INTENT, conf LOW | 不適格 |

- [ENGINE-POLICY] **100m PB → Vmax 推定式は初期ルールセットに入れない**（`vmaxEstimationModels: []`）。追加する場合は §5 の EvidenceRecord と `value/lower/upper/confidence` の出力を必須とし、confidence は最大 LOW。[OPEN-02]
- [ENGINE-POLICY] fly split → 速度: `v = d / t`、区間は `d/(t+tol) .. d/(t−tol)`（tol は §10.2）。
- [ENGINE-POLICY] 記録の鮮度（Fable M-11）※: ageBand ≠ ADULT は 180日超、ADULT は 365日超で confidence を1段下げる（provisional）。
- **[R3 provisional policy]** VIDEO の fly: 上表は RADAR/PHOTO_CELL/FAT（HIGH）と HAND（LOW）
  しか明記していない。v2 初期ポリシーでは **VIDEO fly の基準 confidence = LOW** とし、
  計時法の妥当性を示す Evidence / policy が定まるまで維持する。PHOTO_CELL・FAT・RADAR の
  HIGH を VIDEO へ類推しない。（`timing=VIDEO` で fps 未入力は §10.2 どおり UNKNOWN 扱い。）
  鮮度による1段下げは LOW を NONE に落とさない（HIGH→MEDIUM→LOW→LOW）。
- `prescriptionConfidence` への反映は §5.4。

---

## 5. Evidence Model

### 5.1 Rule 側に保存する（静的）

```ts
export type EvidenceRecord = {
  id: EvidenceId;                         // 例 "EV_HAUGEN_2019_MV_YOUTH_EXAMPLE"
  sourceType:
    | "META_ANALYSIS" | "SYSTEMATIC_REVIEW" | "RCT" | "CROSSOVER_REPEATED_MEASURES"
    | "QUASI_EXPERIMENTAL" | "OBSERVATIONAL" | "MECHANISTIC" | "NARRATIVE_REVIEW"
    | "CONSENSUS_STATEMENT" | "GOVERNING_BODY_GUIDANCE" | "COACHING_BEST_PRACTICE"
    | "ELITE_COACH_PRACTICE" | "EXPERT_OPINION" | "ENGINE_POLICY";
  studyDesign: string | null;             // 例 "crossover, n=10"
  population: {
    ageBands: AgeBand[] | "ANY";
    maturity: MaturityStatus[] | "ANY";
    sexes: Array<"MALE" | "FEMALE"> | "ANY";
    performanceLevels: Array<"YOUTH_DEVELOPING" | "TRAINED" | "NATIONAL" | "ELITE"> | "ANY";
    sport: "TRACK_SPRINT" | "TEAM_SPORT" | "ENDURANCE" | "MIXED" | "GENERAL";
    n?: number | null;
  };
  reference: { citation: string; year: number | null; doi?: string | null; url?: string | null };
  evidenceLevel: 1 | 2 | 3 | 4 | 5;       // 1=最も強い。§5.2 の対応表で機械的に決める
  applicabilityNotes: string;             // 例 "持久系中心。短距離特異的ではない"
  usage: "PRESCRIPTION" | "CONTEXT_ONLY" | "CHECK_ONLY";
  verification: "SECONDARY_REPORT_ONLY" | "PRIMARY_CHECKED";
  reportedBy: Array<"PERPLEXITY_DR" | "CLAUDE_DR" | "CHATGPT_DR" | "GEMINI_DR" | "FABLE_REVIEW" | "HUMAN">;
  provisional: boolean;
};
```

- [ENGINE-POLICY] `directness` と `prescriptionConfidence` は **Rule に保存しない**（Fable C-8）。
- [ENGINE-POLICY] `usage: "CONTEXT_ONLY"` の Evidence は **Envelope の数値フィールドから参照できない**（Zod refine + テスト）。表示の補足にだけ使える。

### 5.2 evidenceLevel の決め方（機械的）[ENGINE-POLICY]

| sourceType | evidenceLevel |
| --- | --- |
| META_ANALYSIS / SYSTEMATIC_REVIEW / CONSENSUS_STATEMENT | 1 |
| RCT | 2 |
| CROSSOVER_REPEATED_MEASURES / QUASI_EXPERIMENTAL / OBSERVATIONAL / MECHANISTIC | 3 |
| NARRATIVE_REVIEW / GOVERNING_BODY_GUIDANCE | 3 |
| COACHING_BEST_PRACTICE / ELITE_COACH_PRACTICE | 4 |
| EXPERT_OPINION / ENGINE_POLICY | 5 |

- evidenceLevel は**研究デザインの強さ**であり、**処方への適用可能性ではない**。適用可能性は §5.3 の directness で決める（Moran の meta-analysis が Haugen より「上」と読まれる事故を防ぐ。Fable H-2）。

### 5.3 directness（runtime 導出）

`deriveDirectness(evidence.population, subjectProfile): Directness` [ENGINE-POLICY]

| 条件 | 結果 |
| --- | --- |
| `sourceType = ENGINE_POLICY` | `NOT_APPLICABLE` |
| sport が TRACK_SPRINT/GENERAL 以外、または maturity が不一致、または ageBand が不一致 | `INDIRECT` |
| 上記に該当せず performanceLevel のみ不一致（例: ELITE 例を TRAINED に適用） | `PARTIAL` |
| すべて一致（`"ANY"` は一致扱い） | `DIRECT` |

- 同じ Haugen elite 例でも、ADVANCED 成人には PARTIAL/DIRECT、PRE の小学生には INDIRECT になる。

### 5.4 prescriptionConfidence（runtime 導出）[ENGINE-POLICY]

入力: 使用した Envelope フィールドの Evidence（最弱のもの）、`inputData` confidence（§4.6）、履歴カバレッジ（§12）。

| 条件（上から順に最初に該当） | 結果 |
| --- | --- |
| 使用した数値フィールドの evidence がすべて ENGINE_POLICY | `POLICY_ONLY` |
| いずれかの directness = INDIRECT、または inputData ∈ {LOW, NONE}、または 72h 履歴カバレッジ = NONE | `LOW` |
| いずれかが PARTIAL、または inputData = MEDIUM、または evidence が `SECONDARY_REPORT_ONLY` のみ | `MODERATE` |
| それ以外 | `HIGH` |

- Phase 3B では、Vittori原著・Petrakos review・現行公式ガイダンス等、実際に照合した限定的な記録だけを `PRIMARY_CHECKED` に更新した。ただし、レビューや公式資料を照合したことは、そこから派生したENGINE_POLICY値を一次実験の普遍的処方へ変えるものではない。HIGH は `PRIMARY_CHECKED`、directness、inputData、履歴の条件をすべて満たす場合に限り得られる。
- **[R4 integration errata]** 72h 履歴カバレッジに `NOT_EVALUATED` を追加する（`HistoryCoverage = COMPLETE | PARTIAL | NONE | NOT_EVALUATED`）。
  R4 は §9.2 step 5（週次・履歴）を接続しないため、`history` の有無に関わらず `NOT_EVALUATED` を渡す。`NOT_EVALUATED` は
  **中立**（上表の LOW 条件「NONE」にも、確認済みの「COMPLETE」にも読み替えない）。R7 で step 5 を接続した後は
  COMPLETE / PARTIAL / NONE のいずれかになり、T-MISS-04（history=null → LOW）はそこで成立させる。
- **[R4 integration errata]** 「使用した Envelope フィールド」= その処方の Envelope のセルのうち、実際に使ったもの。
  `intensityPercent` は数値目標（§9.5）の計算に使ったときだけ、`vdecPercent` は VELOCITY_DECREMENT 参照のときだけ含める。
  directness は ageBand=UNKNOWN（4帯すべて）・EFFECTIVE_UNKNOWN（PRE/CIRCA/POST/UNKNOWN すべて）・GROUP（member ごと）の
  ありうる context で評価して**最も弱いもの**を採用する。全体の directness は ENGINE_POLICY 以外の最弱、すべて ENGINE_POLICY なら
  NOT_APPLICABLE。
- **[R4 provisional policy]** §5.3 の performanceLevel は trainingAge tier から写像する: TRAINED / ADVANCED → `TRAINED`、
  BEGINNER / DEVELOPING → `YOUTH_DEVELOPING`。競技レベルの入力が無いため `NATIONAL` / `ELITE` には写像しない。
- **[R4 errata]** §4.6 の inputData confidence に **`NOT_REQUIRED`** を追加する（`InputDataConfidence = HIGH | MEDIUM | LOW | NONE | NOT_REQUIRED`）。
  「データが不要」と「高品質なデータがある（HIGH）」は別概念であり、HIGH と偽装しない。
  - `NOT_REQUIRED`: 設計上 performance データを必要としない参照 — MethodMeta でそれより優先される**適用可能な**データ参照が
    無いもの（ACCELERATION の MAX_INTENT、STRIDE の RELAXED_SUBMAX、sled の band を持たない RS_HILL_SHORT の MAX_INTENT）。
  - `LOW`: 優先度の高いデータ参照が使えずに落ちてきた fallback（MV の MAX_INTENT、TE の RELAXED_SUBMAX、sled の MAX_INTENT 等。§4.6 表どおり）。
  - コーチ入力の参照（RACE_PACE / TARGET_SPLIT / COACH_DEFINED / 実測 vdec）は MEDIUM、`VELOCITY_DECREMENT.measured=false` は LOW。
  - §4.1 の GROUP の上限（最大 LOW）は参照依存のときだけ適用し、NOT_REQUIRED には適用しない。
  - `derivePrescriptionConfidence` では **中立**: LOW 条件（LOW / NONE）にも MODERATE 条件（MEDIUM）にも該当せず、confidence は
    Evidence / directness / 履歴だけで決まる。ENGINE_POLICYだけを使う処方は `POLICY_ONLY` のまま、source-backed値は実際のverificationとdirectnessに従って評価する。

### 5.5 挙動への接続（表示だけで終わらせない）[ENGINE-POLICY]

| prescriptionConfidence | 数値の位置 | 自動生成 | Finding |
| --- | --- | --- | --- |
| HIGH | phase/competition が決める位置（§14） | 可 | — |
| MODERATE | 同上。ただし `UPPER_HALF` は `MIDDLE` に丸める | 可 | INFO |
| LOW | **recommended の下半分（`LOWER_HALF`）まで** | loadClass=HIGH_METABOLIC の Method は不可 | `REQUIRE_COACH_REVIEW` |
| POLICY_ONLY | LOW と同じ | LOW と同じ | `REQUIRE_COACH_REVIEW` + UI に「暫定ルール」表示 |

- 「下半分」は区間 `[min, (min+max)/2]` の意味で、**係数ではない**。整数フィールドは `floor` で丸め、`min` 未満にはしない。
- rest 系フィールド（repRestS / setRestS / intraRepRestS）は本表の対象外。rest は §9.3 の規則により常に MIDDLE 以上に置き、confidence が低くても短くしない。

### 5.6 初期 EvidenceRecord 一覧（rs-2026.09.0 に収録）

| id | 内容 | sourceType | usage | 判断 |
| --- | --- | --- | --- | --- |
| EV_HAUGEN_2019_REVIEW | 短距離トレーニングの科学と best practice の統合 | NARRATIVE_REVIEW | PRESCRIPTION | [SOURCE-BACKED] |
| EV_HAUGEN_2019_ACC_EXAMPLES | 加速 10–50m / recovery 2–7分 / session 100–300m（best-practice synthesis）。youth/elite例はcoach example | COACHING_BEST_PRACTICE（UKA 由来） | PRESCRIPTION | [SYNTHESIZED / provisional] |
| EV_HAUGEN_2019_MV_EXAMPLES | build 20–60m / fly 10–30m / recovery 4–15分（best-practice core）。youth/elite例はcoach example | COACHING_BEST_PRACTICE | PRESCRIPTION | [SYNTHESIZED / provisional] |
| EV_HAUGEN_2019_SES_EXAMPLES | 7–15秒・95–100%・recovery 8–30分・volume 300–900m（best-practice synthesis）。rep数はcoach example | COACHING_BEST_PRACTICE | PRESCRIPTION | [SYNTHESIZED / provisional] |
| EV_HAUGEN_2019_VOLUME_TABLE | Acc 100–300m / MV fly 50–150m / SES 300–900m / Tempo 1000–2000m | COACHING_BEST_PRACTICE | PRESCRIPTION | [MULTI_SOURCE_SYNTHESIS / provisional]（Perplexity・Gemini DR。Claude は Acc 100–160m と報告 → 不一致を applicabilityNotes に記載） |
| EV_HAUGEN_2019_TEMPO | 100–300m、約60–70% Vmax、prep 約2000m / comp 約1000m | ELITE_COACH_PRACTICE | PRESCRIPTION | [ELITE COACHING PRACTICE / not universal youth dose] |
| EV_HAUGEN_2019_VITTORI | Haugenの二次 retelling（60–80m、約90→95%、rep/set休息） | ELITE_COACH_PRACTICE | CONTEXT_ONLY | [SECONDARY / historical retelling] |
| EV_VITTORI_1981_PRIMARY | 60/80mおよび60/80/100m framework、phase依存のmicro/macro rest、near-maximal構造 | COACHING_BEST_PRACTICE | PRESCRIPTION（TI_VITTORI_SEの歴史的method contextに限定） | [PRIMARY_CHECKED / historical method] |
| EV_HAUGEN_2019_48H | 高強度セッションは通常48h程度離す | COACHING_BEST_PRACTICE | CHECK_ONLY | [SOURCE-BACKED] |
| EV_UKA_CLASSIFICATION | 強度帯（95–100 / 76–94 / <75）、完全/不完全回復 | COACHING_BEST_PRACTICE | CHECK_ONLY | [SOURCE-BACKED]（Claude DR） |
| EV_PETRAKOS_2016_VDEC | vdec <10 / 10–15 / 15–30 / >30% | SYSTEMATIC_REVIEW | CHECK_ONLY（classificationのみ） | [PRIMARY_CHECKED / no load prescription] |
| EV_RESISTED_META_2024_2025 | resisted は主に 10m/加速に効果、重いほど良いとは言えない | META_ANALYSIS | CONTEXT_ONLY | [SOURCE-BACKED] |
| EV_ASSISTED_EVIDENCE_LIMITED | assisted の長期効果データは限定的 | SYSTEMATIC_REVIEW | CHECK_ONLY | [SOURCE-BACKED] |
| EV_MORAN_2016_YOUTH_DOSE | 週2回・約20m×最大16本・work:rest 1:25 または ≥90秒（男子ユース・主に団体競技） | META_ANALYSIS | **CONTEXT_ONLY / notForPrescription** | [SOURCE-BACKED]（Fable H-2 により処方不可） |
| EV_MATURITY_NOT_AGE | 暦年齢・学年から成熟度を確定しない | SYSTEMATIC_REVIEW + CONSENSUS | CHECK_ONLY | [SOURCE-BACKED] |
| EV_GROWTH_VELOCITY_7_2 | 成長速度 >7.2cm/年で傷害リスク上昇の目安 | NARRATIVE_REVIEW | CHECK_ONLY | [CHECK_ONLY / male academy football marker; no hard cutoff]（Claude DR のみ） |
| EV_BOSQUET_2007_TAPER | 約2週間、volume −41〜60%、intensity/frequency 維持（**短距離特異的ではない**） | META_ANALYSIS | CONTEXT_ONLY | [GENERAL TAPER CONTEXT / not sprint-specific] |
| EV_RESISTED_RECOVERY_2023 | 20%BM resisted 後 30m 低下が 72h まで | CROSSOVER_REPEATED_MEASURES | CHECK_ONLY | [SOURCE-BACKED]（ChatGPT/Perplexity DR） |
| EV_THOMAS_2018 | squat/jump/sprint 後の疲労 48–72h（n=10 成人男性・15×30m・crossover。**RCT ではない**） | CROSSOVER_REPEATED_MEASURES | CHECK_ONLY | [SOURCE-BACKED]（Fable M-9 の訂正を反映） |
| EV_WELLNESS_SR | 主観的 wellness は負荷変化に客観指標より一貫して反応 | SYSTEMATIC_REVIEW | CHECK_ONLY | [SOURCE-BACKED] |
| EV_TIMING_ERROR_REPORTS | 手動計時の誤差・MDC、timing gate の CV 1.1–2.4% | OBSERVATIONAL | CHECK_ONLY | [SOURCE-BACKED]（Perplexity/Gemini DR） |
| EV_JAAF_JHS_GUIDE | 日本の学校部活動・適用対象の認定地域クラブにおける現行ガイダンス（休養≥2日、平日約2h、休日約3h、週約11h） | GOVERNING_BODY_GUIDANCE | CONTEXT_ONLY | [PRIMARY_CHECKED / institutional context only] |
| EV_ENGINE_SAFETY_POLICY | 誘発負荷の停止/変更、assessment、持続症状・red flagの医療評価 | ENGINE_POLICY | CHECK_ONLY | [ENGINE-POLICY / non-diagnostic; no JSPO attribution] |
| EV_JAAF_WIND_SPRINT | JAAFのevent/phase付きwind sprint coaching examples | GOVERNING_BODY_GUIDANCE | CONTEXT_ONLY | [PRIMARY_CHECKED / examples, not generic STRIDE prescription] |
| EV_ENGINE_POLICY | 本アプリの暫定運用値 | ENGINE_POLICY | PRESCRIPTION | [ENGINE-POLICY] |

- **不採用**（ルールセットに入れない）: 「10m=60秒」（全DRが根拠なしと報告）、「3%/5% の普遍 drop-off」、「女性 rest×0.95」（Gemini のみ）、「中学生×0.6」「期分け固定 pp」。

---

## 6. Rule Versioning

### 6.1 形式 [ENGINE-POLICY]
- ルールセット = **1 版 1 ファイルの JSON**: `src/domain/running/rules/sets/<version>.json`
- 版番号: `rs-YYYY.MM.N`（初版 `rs-2026.09.0`）
- TS 定数に数値を直書きしない（Fable H-9 / 監査 L-3・M-7 の再発防止）。TS 側は `RuleSetSchema`（Zod）と loader のみ。

```ts
export type RuleSet = {
  ruleSetVersion: string;            // "rs-2026.09.0"
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  validFrom: IsoDate;
  supersedes: string | null;
  engineSchemaVersion: 1;            // この JSON を読める RuleSetSchema の版
  changelog: string[];
  evidence: EvidenceRecord[];
  methods: MethodMeta<RunningTrainingMethod>[];
  templates: SessionTemplate<RunningTrainingMethod>[];
  envelopes: Envelope[];             // §7
  eligibility: EligibilityRule[];    // §4.4 の表
  constraints: ConstraintRule[];     // ageBand / trainingAge / confidence
  timingTolerances: TimingToleranceRule[];   // §10.2
  stopPolicies: StopPolicy[];                // §10.3
  aggregationRules: AggregationRule[];       // §11
  weeklyRules: WeeklyRule[];                 // §12
  readinessRules: ReadinessRule[];           // §13
  phaseRules: PhaseRule[];                   // §14
  competitionRules: CompetitionRule[];       // §14
  plausibility: PlausibilityRule[];          // §8.5
  vmaxEstimationModels: [];                  // 初版は空（§4.6）
};
```

- **[R4 errata]** planning が人間向け文字列や ID の命名規約を実行ロジックにしないよう、構造メタデータを追加する
  （rs-2026.09.0 は DRAFT のまま・数値データは不変・changelog に記録・manifest hash 更新）:
  - `EligibilityRule.conditions` / `EligibilityRule.autoGenerationLimits`（§4.4 R4 errata）
  - `SessionTemplate.approachType`（EVENT_APPROACH_SPEED の SHORT / FULL）、`SessionTemplate.resistanceBand`（sled の負荷 band。
    VELOCITY_DECREMENT.band と照合）、`SessionTemplate.fixedDistanceField`（`displayDistanceM` を固定値として使うフィールド。
    null なら displayDistanceM は表示専用）
  - `StopPolicy.appliesToEligibilityPath`（`ANY` / `AUTO_CONDITIONS_MET` / `MANUAL_OR_OVERRIDE`。§10.3 R4 errata）
  - `PlausibilityRule.inputTarget`（scope=INPUT の行が検査する入力: TIMED_MARK の event / HEIGHT_CM / COACH_EDIT_APPROACH_DISTANCE_M）
  - `eventDefinitions`（`timedMarks[]: { event, distanceM, segment: FROM_START | FLY_ZONE }`、`raceEvents[]: { event, distanceM, hurdles }`。
    "FLY20" や "400m" の文字列から距離を読み取らないための種目定義）
  - RuleSet の行は id の**完全一致で参照するだけ**で、id・templateId・表示名を解析して意味を取り出さない。

### 6.2 不変性と追跡
- [ENGINE-POLICY] `rules/manifest.json` に `{ version, status, contentHash(sha256 of canonical JSON), validFrom }` を列挙。
- [ENGINE-POLICY] テスト `rules-manifest.test.ts` が各ファイルの hash を計算し manifest と照合。**status が ACTIVE/RETIRED になった版のファイルを 1 byte でも変えるとテスト失敗**。DRAFT 版だけ編集可（hash 更新を伴う）。
- [ENGINE-POLICY] canonical JSON: キーをソートし空白なしで直列化した UTF-8。
- 研究更新時の手順:
  1. 新ファイル `rs-YYYY.MM.N+1.json` を作成（`supersedes` に旧版）
  2. 変更点を `changelog` に記載し、変わった Envelope の evidenceIds を更新
  3. テスト（全 test matrix §20）を通す
  4. 人間の承認後に `status: ACTIVE`、旧版を `RETIRED`
- `getActiveRuleSet(at)`: `status=ACTIVE` かつ `validFrom ≤ at` の最新。ACTIVE が無い場合は最新 DRAFT を返し、全出力に `ruleSet.status="DRAFT"` と Finding `RULESET_DRAFT`（INFO）を付ける。[ENGINE-POLICY]
- **RETIRED 版は削除しない**（過去処方の説明に使う）。ただし新規処方には使わない。

### 6.3 MenuItem / SessionItem に保存するもの（結論）

| 保存項目 | 必要性 | 判断 |
| --- | --- | --- |
| `ruleSetVersion` | どの版で出たか | 必須 [ENGINE-POLICY] |
| `ruleSetContentHash` | 版番号の書き換え事故の検出 | 必須 [ENGINE-POLICY] |
| `prescriptionJson`（`RunningPrescription` 全体） | range・位置・露出区間・stop policy を後から再現 | 必須 [ENGINE-POLICY] |
| `provenanceJson`（入力要約・actor・override 履歴・evidenceIds） | なぜその数値か／誰が変えたか | 必須 [ENGINE-POLICY] |
| `rationale`（日本語テキスト） | ルールセットが変わっても当時の説明文を固定 | 必須 [ENGINE-POLICY] |

- 結論: **schema 変更が必要**（§16）。`note` 1000文字だけでは再現・説明ができない（監査 H-7）。

---

## 7. Method Envelopes

### 7.1 3層 + plausibility の意味（確定）

| 層 | 意味 | 出典条件 | 超えたとき |
| --- | --- | --- | --- |
| `recommended` | 研究・best practice 由来の推奨範囲。エンジンが値を置く範囲 | best practice / 研究 / ENGINE-POLICY | コーチ編集は可。Finding `OUTSIDE_RECOMMENDED`（WARN） |
| `coachEditable` | コーチが override なしで入力できる範囲 | ENGINE-POLICY のみ | `CoachOverride`（理由必須・ログ）が必要 |
| `hardSafety` | 安全上の明確な禁止・app policy・年齢制約 | **Haugen 等の best practice を使わない**。GOVERNING_BODY / 明示的禁止 / app policy のみ | 原則不可。§8.3 の override 可否表に従う |
| `plausibility` | 入力ミス・単位破綻・sets/reps 取り違えの検出 | ENGINE-POLICY | BLOCK または REQUIRE_CONFIRMATION（override 不可、入力を直す） |

- [ENGINE-POLICY] **rs-2026.09.0 では数値の `hardSafety` はすべて `null`**。4レポートに「安全上限」として出典のある数値が存在しないため。安全は数値上限ではなく **eligibility ゲート（§4.4・§8.2）と pain gate（§13）** で担保する。
- [ENGINE-POLICY] AI は `recommended` の中でしか値を持てない（§18）。`coachEditable` の拡張権限は誰にも無い（ルールセット改版のみ）。

### 7.2 Envelope 型

```ts
export type EnvelopeField =
  | "repDistanceM" | "buildUpM" | "flyZoneM" | "decelerationM" | "repDurationS"
  | "repsPerSet" | "sets" | "totalReps" | "repRestS" | "setRestS" | "intraRepRestS"
  | "sessionVolumeM" | "flyVolumeM" | "intensityPercent" | "attempts" | "vdecPercent";

export type EnvelopeCell = {
  recommended: Range | null;      // null = エンジンは値を置かない（手動入力のみ）
  coachEditable: Range;
  hardSafety: Range | null;
  evidenceIds: EvidenceId[];      // usage=PRESCRIPTION の Evidence のみ参照可
  judgement: "SOURCE_BACKED" | "ENGINE_POLICY" | "OPEN";
};

export type Envelope = {
  method: RunningTrainingMethod;
  tier: EnvelopeTier;
  templateIds: SessionTemplateId[];
  recoveryStructure: RecoveryStructure | null;
  fields: Partial<Record<EnvelopeField, EnvelopeCell>>;
};
```

### 7.3 値の置き方（係数を使わない）[ENGINE-POLICY]

- `position` → 値: `LOWER_BOUND = min` / `LOWER_HALF = min + (max−min)×0.25` / `MIDDLE = (min+max)/2` / `UPPER_HALF = min + (max−min)×0.75`。**範囲内の位置指定であり、量への乗数ではない。**
- 丸め: 距離 50m 以上は 10m 単位、未満は 5m 単位／秒は 30秒単位（60秒未満は 15秒単位）／回数は `UPPER_HALF` のみ四捨五入、それ以外は切り捨て。すべて `recommended.min` 未満にしない。
- template が距離を固定する場合（`ACC_BLOCK_20` = 20m、`MV_FLY20` = fly 20m 等）は template 値を優先し、範囲外なら Finding。
- 解決順: ①template 固定値 → ②`totalReps` を reps 範囲かつ `sessionVolumeM`（または `flyVolumeM`）範囲に収まる最大値で決定 → ③`sets` を最小にし `repsPerSet` を範囲内に → ④rest。解が無ければ `ENVELOPE_INFEASIBLE`（BLOCK_AUTOGEN）。
- **[R4 errata]** 丸め・解決順の実装で確定した事項（係数は一切使わない）:
  - rest（repRestS / setRestS / intraRepRestS）は「最低この時間」なので秒の単位（30秒 / 60秒未満は15秒）へ**切り上げ**、
    recommended.max を超える場合は max。切り捨てると MIDDLE より短くなり §9.3 の「rest は常に MIDDLE 以上」に反するため。
  - 1本の時間（repDurationS。7–15秒等）に 15/30 秒単位を当てると範囲が潰れる（常に min になる）ため、**1秒単位で切り捨て**
    （recommended.min 未満にしない）。
  - ① の template 固定値は `SessionTemplate.fixedDistanceField`（repDistanceM / flyZoneM）が指すフィールドだけに適用し、値は
    `displayDistanceM`（origin=TEMPLATE_FIXED）。SES の displayDistanceM は表示専用で固定しない。
  - ② の「reps 範囲」は `totalReps`（EVENT_APPROACH_SPEED は `attempts`）の recommended.min 〜 位置で置いた値、「総量範囲」は
    recommended.min 〜 位置の点（丸めなし）。`EligibilityRule.autoGenerationLimits.maxTotalReps` もここで上限に加える。
    ③ の sets / repsPerSet は、totalReps セルを持つ Method では recommended 内の構造的な分解（origin=SOLVER_DERIVED、位置上限は
    総本数と総量に適用済み）、totalReps セルを持たない Method（TEMPO / STRIDE）では sets / repsPerSet 自体に位置上限を適用する。
    sets × repsPerSet = totalReps（端数を作らない）。
  - **RunningPrescription schemaVersion=1 の構造正規化規則**: RuleSet に sets の次元（sets セル）が存在しない template
    （LONG / RESISTED / ASSISTED / EVENT_APPROACH）は、単一 set の表現として `sets = 1` を origin=`STRUCTURAL_FIXED`
    （range [1,1]・evidenceIds 空・position なし）で snapshot する。これは **training dose の推奨ではなく**、sets / repsPerSet 非 null の
    不変条件（§2.5）を満たすための表現規則であり、rationale で「セット数の推奨ではない」ことを示す。将来 RuleSet に sets セルが
    追加されたら必ずそちらを使う。repsPerSet セルが無い Method の repsPerSet は totalReps（attempts）セルの範囲で表し、
    コーチが sets を入力した場合の「総本数 ÷ sets」も STRUCTURAL_FIXED（coachEditable 内必須、recommended 外は WARN）。
  - コーチが回数（totalReps / sets / repsPerSet）のいずれかを入力した場合、総量は位置上限ではなく coachEditable で検査する
    （外なら CoachOverride、recommended 外なら WARN）。総量（sessionVolumeM / flyVolumeM）は回数×距離の結果であり、
    CoachFieldEdit の対象にしない。
  - MAX_VELOCITY の減速区間（decelerationM）は安全のための距離なので、rest と同じく低 confidence / LOWER 希望で短くしない（MIDDLE）。
  - template 固定値が coachEditable の外（例: DEVELOPMENTAL の ACC_BLOCK_40 = 40m > 30m）の場合、値を clamp せず、
    AI / SYSTEM は BLOCKED、COACH は `newValue` = template 値の FIELD override を付けたときだけ処方する。

### 7.4 rs-2026.09.0 の Envelope 値

表記: `推奨 / 編集可`。単位は列名。`—` = 該当なし。判断ラベル: **SB**=SOURCE-BACKED、**EP**=ENGINE-POLICY、**OP**=OPEN。

#### ACCELERATION（template が距離を固定）

| field | DEVELOPMENTAL | ADVANCED | 判断・根拠 |
| --- | --- | --- | --- |
| repDistanceM | 10–20 / 10–30 | 20–50 / 10–60 | 10–50m は best-practice synthesis。DEV/ADV の縮約は ENGINE_POLICY、youth/elite 例を実験的 tier 境界にしない |
| totalReps | 4–8 / 3–10 | 3–8 / 2–12 | EP（ChatGPT DR の保守プリセット・envelope）。Moran 16本は **参照しない** |
| repsPerSet | 3–6 / 2–8 | 3–5 / 2–8 | EP |
| sets | 1–2 / 1–3 | 1–3 / 1–4 | EP |
| repRestS | 120–180 / 90–300 | 180–420 / 120–600 | 2–7分は best-practice synthesis。DEV/ADV の縮約と幅は ENGINE_POLICY、youth/elite 例を普遍閾値にしない |
| setRestS | 240–420 / 180–600 | 300–600 / 240–900 | EP |
| sessionVolumeM | 60–160 / 40–200 | 100–300 / 80–400 | ADV推奨 SB（Haugen 表。Claude は 100–160 と報告 → OPEN-07）、DEV は EP |

#### MAX_VELOCITY（template が fly を固定）

| field | DEVELOPMENTAL | ADVANCED | 判断・根拠 |
| --- | --- | --- | --- |
| buildUpM | 15–25 / 15–30 | 30–60 / 20–70 | 20–60m は best-practice core。DEV の15m開始値は ENGINE_POLICY、ADV の core 適用も synthesis として扱う。**選手の加速距離推定（§11.2）と矛盾する場合 Finding** |
| flyZoneM | 10–10 / 10–20 | 20–30 / 10–40 | youth 10m・elite 30m・範囲 10–30（SB）、編集可 EP |
| decelerationM | 20 固定 | 30 固定 | EP（露出に計上しない） |
| totalReps（fly 本数） | 2–3 / 1–4 | 3–6 / 2–8 | EP（ChatGPT/Perplexity DR） |
| sets | 1–1 / 1–2 | 1–2 / 1–3 | EP |
| repRestS | 180–300 / 150–420 | 480–900 / 240–1080 | 4–15分は best-practice core。DEV の3分開始値と tier 差分は ENGINE_POLICY |
| setRestS | — / 300–600 | 600–900 / 480–1200 | EP |
| flyVolumeM | 20–40 / 10–60 | 50–150 / 20–180 | ADV推奨 SB（Haugen 表）、DEV推奨 EP（ChatGPT プリセット。Fable は Haugen youth 例と記載 → OPEN-08） |

- 手動計時（HAND）で `MV_FLY10` を選んだ場合: 距離は変えず、Quality Stop を `COACH_ONLY` にする（§10.2）。[ENGINE-POLICY]（Gemini DR の「手動なら fly 20m 以上」は採用せず、計時法側で吸収）

#### SPRINT_ENDURANCE_SHORT（一次軸 = 時間）

| field | DEVELOPMENTAL | ADVANCED | 判断・根拠 |
| --- | --- | --- | --- |
| repDurationS | 7–12 / 6–13 | 7–15 / 6–17 | 7–15秒（SB: Haugen/UKA）。DEV 上限は EP |
| 分類ヒステリシス | 13–17秒 → `COACH_CONFIRM`（SES か LSR か） | 同左 | EP（Fable C-4） |
| totalReps | 2–3 / 1–4 | 4–6 / 2–6 | youth 2–3本・elite 4–6本は coaching example。tier dose は ENGINE_POLICY、普遍的な実験処方ではない |
| sets | 1–1 / 1–2 | 1–2 / 1–2 | EP |
| repRestS | 480–720 / 420–900 | 1200–1800 / 600–1800 | youth 約10分・elite 20–30分（SB）、幅 EP |
| sessionVolumeM（表示用距離） | 150–300 / 100–400 | 300–900 / 200–900 | ADV SB（Haugen 表）、DEV EP |

- [ENGINE-POLICY] `availableMinutes` があり `totalReps × repRest` がそれを超える場合 Finding `REST_INFEASIBLE_FOR_PRACTICE`（WARN）。rest は**下限（floor）として表示**し、人数・時間で詰めない旨を出す（Fable C-2・L-3）。

#### LONG_SPRINT_RACE_SPECIFIC

| field | DEV（POST・手動のみ・FULL） | ADV FULL | ADV INCOMPLETE | 判断 |
| --- | --- | --- | --- | --- |
| repDurationS | 15–30 / 15–40 | 15–45 / 15–60 | — | ADV は ChatGPT DR envelope（15–60+）を EP で狭めた。DEV は OP-09 |
| segments（INCOMPLETE） | — | — | 2–3 区間、各 100–300m | EP（template 定義） |
| intraRepRestS | — | — | 45–90 / 30–180 | 分割走の区間休息約1分の例（Claude DR）を端点、幅 EP |
| totalReps（本数 or 分割走セット） | 1–2 / 1–2 | 1–3 / 1–4 | 1–2 / 1–3 | EP（ChatGPT DR 1–4） |
| repRestS（本間 or セット間） | 900–1500 / 900–1800 | 900–1800 / 600–2400 | 900–1800 / 600–2400 | EP（ChatGPT DR 10–30+分） |
| sessionVolumeM | 150–400 / 150–400 | 300–800 / 200–1000 | 400–800 / 300–1000 | EP（ChatGPT 300–1000 / Perplexity 300–1200）、DEV は OP-09 |
| DEV INCOMPLETE | **提供しない（不適格）** | | | §4.4 |

#### TEMPO_EXTENSIVE

| field | DEVELOPMENTAL | ADVANCED | 判断・根拠 |
| --- | --- | --- | --- |
| intensityPercent（数値参照がある場合のみ） | 60–70 / 55–75 | 60–70 / 55–75 | 60–70% は elite sprint coaching practice をレビューが記録した値。一般 youth の universal science-backed dose ではなく、下限・tier適用は EP |
| repDistanceM | 100–200 / 60–300 | 100–300 / 60–400 | ADV SB（100–300）、DEV EP |
| repsPerSet | 3–8 / 2–10 | 4–10 / 2–12 | EP |
| sets | 1–2 / 1–3 | 1–3 / 1–4 | EP |
| repRestS | 45–120 / 30–180 | 45–120 / 30–180 | EP（DR 間で 0.5–3分と不一致） |
| setRestS | 120–300 / 60–360 | 120–300 / 60–360 | EP |
| sessionVolumeM | 400–1000 / 300–1500 | 1000–2000 / 600–2500 | ADV SB（準備期約2000m・試合期約1000m）、DEV は EP（OP-10） |

#### TEMPO_INTENSIVE（enabledByDefault=false）

| field | TI_VITTORI_SE（ADVANCED のみ） | TI_COACH_DEFINED（recommended=null・手動のみ） | 判断 |
| --- | --- | --- | --- |
| repDistanceM | 60–80 / 50–100 | null / 80–300 | VITTORI SB（60–80m）、他 EP |
| intensityPercent | 90–95 / 88–95 | null / 70–94 | 現行 90–95% は ENGINE_POLICY。Vittori 原著の near-maximal 約95–98%と、Haugen の二次 retelling 約90→95%を同一の exact prescription として扱わない |
| repRestS | 90–150 / 60–180 | null / 60–360 | VITTORI 約2分（SB）を中心に EP 幅 |
| setRestS | 420–540 / 360–720 | null / 180–720 | 約8分（SB）を中心に EP 幅 |
| repsPerSet | 3–5 / 3–5 | null / 1–10 | EP |
| sets | 2–4 / 2–4 | null / 1–4 | EP |
| sessionVolumeM | 600–1200 / 400–2000 | null / DEV≤800, ADV≤1600 | EP |

- **[R2 errata]** 上記 `repsPerSet` / `sets` の行は、初版（R2実装前）では
  「repsPerSet / sets | 3–5 / 2–4」という1行に2変数を圧縮して記載しており、
  どちらの数値がどちらの変数を指すか一意に読み取れなかった。R2 の
  RuleSet 実装時にこの曖昧さが判明したため、本書を2行に分離して
  「repsPerSet = 3–5（recommended・coachEditable とも）」
  「sets = 2–4（recommended・coachEditable とも）」と確定する
  （coachEditable の追加拡張は行わない。TI_VITTORI_SE の recommended/coachEditable
  が一致するのは意図的で、他の EP 値のように編集幅を広げる根拠が本書に無いため）。

#### RESISTED_SPRINT

| field | DEVELOPMENTAL | ADVANCED | 判断・根拠 |
| --- | --- | --- | --- |
| vdecPercent（sled） | 専用 classification bands を snapshot（LIGHT: x<10、MODERATE: 10≤x<15、15≤x≤30: unresolved review、VERY_HEAVY: x>30） | 同左 | Petrakos は classification/check の根拠。classification は load prescription ではない。15–30 は named empirical band にしない |
| vdec 実測 | 無い場合 band は `measured:false`・confidence LOW。VERY_HEAVY は COACH_REVIEW | 同左 | EP / CHECK_ONLY |
| HILL | vdec を使わない（平地参照が無い） | 同左 | EP（Fable M-13） |
| repDistanceM | 10–20 / 10–30 | 10–30 / 10–40 | DEV=ENGINE_POLICY、ADV=SOURCE_BACKED（OPEN-23: Haugen 2019 Table 2 の Resisted sprints 10–30m=BEST_PRACTICE_SYNTHESIS）。Vdec 分類は load classification であり repDistance 処方ではない |
| totalReps | 4–6 / 3–8 | 4–8 / 3–10 | EP |
| repRestS | 120–240 / 90–360 | 180–360 / 120–480 | EP（Perplexity 3–6分） |
| sessionVolumeM | 40–120 / 30–160 | 50–200 / 40–240 | EP（Perplexity DR 構成） |

#### ASSISTED_SPRINT（ADVANCED のみ・自動生成しない）

| field | ADVANCED（recommended はすべて null） | 判断 |
| --- | --- | --- |
| buildUpM / flyZoneM | 編集可 20–60 / 10–30 | EP |
| totalReps | 編集可 2–6 | EP |
| repRestS | 編集可 300–900 | EP |
| intensityPercent | 編集可 100–105（recommended=null） | EP（Perplexity DR「原則105%以下」、根拠は弱いと明記） |
| flyVolumeM | 編集可 ≤100 | EP |

- **[R2 errata]** 初版では「assistedSpeed」という独立フィールドとして記載していたが、
  §7.2 の `EnvelopeField` 列挙に該当項目が無い。新しい `EnvelopeField` を追加する
  代わりに、既存の `intensityPercent`（`EnvelopeField` に既存）を
  「実測 Vmax に対する百分率」という representation として流用し、
  `coachEditable = 100–105%` で表現する。**100% という下限は「assisted =
  通常 Vmax を超える曝露である」ことを Range で表すための representation
  policy であり、科学的閾値ではない。** 105% を hardSafety へ昇格させることもしない
  （引き続き `hardSafety = null`）。`EV_ASSISTED_EVIDENCE_LIMITED`
  （usage=CHECK_ONLY）はこの cell の `evidenceIds` には含めない
  （`EV_ENGINE_POLICY` のみを参照する）。

#### EVENT_APPROACH_SPEED（coach-configured）

| field | DEVELOPMENTAL | ADVANCED | 判断 |
| --- | --- | --- | --- |
| attempts | 3–6 / 2–8 | 4–8 / 2–10 | EP（Perplexity DR APPROACH_RUN 3–10、根拠 E4/U）→ OP-13 |
| repRestS | 180–360 / 120–480 | 180–480 / 120–600 | EP |
| approachDistanceM | 手入力（plausibility ≤60m） | 同左 | EP |
| 高速曝露・荷重 | FULL 助走は §11 で計上。踏切/ハードル実施フラグで JUMPS/HURDLES 負荷も計上 | 同左 | EP（Fable M-15） |

- **[R2 errata]** `approachDistanceM` は **EnvelopeCell ではない**。
  §2.4 の `AttemptsRepSpec.approachDistanceM: FieldValue<"m"> | null` が示すとおり
  **コーチの手入力値**であり、`recommended`/`coachEditable` をエンジンが提示する
  対象ではない。R2 では `PlausibilityRule`（scope=INPUT）として
  「手入力・plausibility ≤60m（REQUIRE_CONFIRMATION）」の形でのみ保持し、
  手入力値を `FieldValue<"m">` へ変換する方法（`coachEditable`/`recommended` を
  どう埋めるか）は R4（Planning Engine）の実装時に定める。R2 時点で
  新しい数値レンジを発明しない。

#### STRIDE（TEMPO_EXTENSIVE とは別 Envelope）

| field | 全 tier 共通 | 判断・根拠 |
| --- | --- | --- |
| intensity | `RELAXED_SUBMAX`（数値%なし。UI 表示「リラックスして徐々に上げる・全力にしない」） | EP（「<90%」等の数値は DR 間で不一致のため数値化しない） |
| repDistanceM | 80–120 / 50–150 | 100–150m（SB: JAAF・Claude DR）と 60–120m（Fable）の重なりを推奨、編集可上限 150 は SB |
| repsPerSet | 3–4 / 2–6 | 3–4本（SB: JAAF）、2–6（EP: Fable） |
| sets | 1–1 / 1–2 | EP |
| repRestS | 60–180 / 30–240（歩いて戻る） | EP |
| sessionVolumeM | 240–480 / 100–900 | EP |
| 高速曝露 | 0（`RULE_DEFINITION`）。48h ルールの対象外 | EP（Fable H-1） |

- [ENGINE-POLICY] **STRIDE に TEMPO_EXTENSIVE の 1000–2000m を適用しないことをテストで保証**（§20 T-STR-02）。

### 7.5 complexity（Fable H-10 で未定義だった概念の確定）[ENGINE-POLICY]

| complexity | 該当 template（例） |
| --- | --- |
| LOW | ACC_STANDING_20, ACC_FALLING_10, MV_FLY10（平地）, TE_*, ST_* |
| MEDIUM | ACC_CROUCH_20, ACC_BLOCK_10/20/30/40, MV_FLY20/30, SES_*, RS_SLED_LIGHT/MODERATE, RS_HILL_SHORT, EA_JUMP_SHORT_APPROACH, TI_* |
| HIGH | RS_SLED_HEAVY, AS_*, EA_HURDLE_START_TO_H1, EA_HURDLE_RHYTHM, EA_JUMP_FULL_APPROACH, LSR_* |

- 制約: maturity ∈ {PRE, EFFECTIVE_UNKNOWN, CIRCA} または trainingAge=BEGINNER のとき、**自動生成は complexity ≤ MEDIUM**。HIGH は手動のみ。complexity は**乗数ではなく許可集合の絞り込み**。

---

## 8. Safety Constraints

### 8.1 多層防御（どれか1層に依存しない）

| 層 | 実施箇所 | 内容 |
| --- | --- | --- |
| L1 型・Zod | 入力受け取り時 | 範囲外・欠損・method と template の不整合を拒否 |
| L2 入力 plausibility | pipeline 1 | 桁ミス（100m PB 1.0秒、身長 1700cm 等） |
| L3 Pain / red flag gate | pipeline 2・monitor | 痛み・危険兆候（§13） |
| L4 Eligibility | pipeline 3–7 | maturity / ageBand / trainingAge / データ有無 / advancedOnly / 週次・大会 |
| L5 hardSafety 数値 | pipeline 8・13 | rs-2026.09.0 では null（将来の出典付き上限用） |
| L6 出力 plausibility | pipeline 14 | 80km 事故・sets/reps 取り違え |
| L7 Session aggregation | 項目追加ごと | メニュー全体の累積（§11） |
| L8 Snapshot 検証 | `createSessionFromMenu` | JSON を Zod で再検証（再計算はしない） |

### 8.2 ageBand 制約（maturity とは独立に重ねる）[ENGINE-POLICY]

| ageBand | 追加制約 |
| --- | --- |
| U12 | ASSISTED・LONG（全）・RS_SLED_HEAVY・TEMPO_INTENSIVE（全）を**不適格（override 不可）**。自動生成は complexity LOW のみ |
| U15 | **ASSISTED_SPRINT を不適格（override 不可）**。年齢帯だけから institutional weekly guidance を自動適用しない（§12.4） |
| U18 | 未成年の健康情報の取り扱い規則（§13.5）を適用 |
| ADULT | 追加制約なし |

- 早熟な U12（maturity=POST）でも U12 の制約は外れない。[ENGINE-POLICY]
- **[R3 errata]** 初版の本表は U15 に ASSISTED の制約を書いていなかったため、§4.4 の表だけでは
  「U15・POST・EnvelopeTier=ADVANCED」の ASSISTED が「手動」になり、§20 T-POP-07
  （「U12/U15 と PRE/CIRCA/UNKNOWN は coach override でも不可」）と矛盾していた。
  T-POP-07 に合わせて U15 行へ「ASSISTED_SPRINT 不適格（override 不可）」を追加する。
  RuleSet では U12 の制約と混ぜず、独立した ConstraintRule
  `CONSTRAINT_U15_ASSISTED_NONOVERRIDABLE` として保持する（U12 は LONG/TI/RS_SLED_HEAVY も
  禁止するため別ルールのまま）。**U18 は年齢だけで ASSISTED を禁止しない**：U18 でも
  POST・EnvelopeTier=ADVANCED・allowAdvancedMethods=true・vmax.confidence ≥ MEDIUM なら
  手動候補になりうる（自動生成はしない。§4.5）。PRE/CIRCA/EFFECTIVE_UNKNOWN は §4.4 の表で
  override 不可のまま。
- 方向性（小学生で overspeed・長い解糖系・重い抵抗を避ける）は [SOURCE-BACKED]（Claude/Perplexity/ChatGPT DR）。

### 8.3 Override 可否

```ts
export type CoachOverride = {
  target: { kind: "ELIGIBILITY"; ruleId: string } | { kind: "FIELD"; field: EnvelopeField; layer: "COACH_EDITABLE" | "HARD_SAFETY" };
  newValue?: number;
  reason: string;               // 10文字以上
  confirmedTwice: boolean;      // HARD_SAFETY と ELIGIBILITY は true 必須
  actor: CoachActor;            // §18。AI からは型的に作れない
  at: IsoDateTime;
};
```

| 対象 | override |
| --- | --- |
| recommended の外・coachEditable の内 | 不要（WARN のみ） |
| coachEditable の外・hardSafety の内 | CoachOverride（理由必須） |
| eligibility「override 可」 | CoachOverride（理由 + 二重確認） |
| eligibility「override 不可」（§4.4 / §8.2） | **不可** |
| pain red flag による STOP / MEDICAL_EVALUATION_RECOMMENDED | **不可** |
| plausibility METHOD_POLICY_HARD / PRODUCT_DATA_SANITY_HARD / NON_OVERRIDABLE_DATA_SANITY_HARD | **不可**（方法の定義または入力境界を修正する） |
| plausibility COACH_OVERRIDABLE_STRONG_REVIEW（F1/F2） | F1では未承認のためBLOCK。F2はruleId単位のdigest-bound review contractとprovenance schemaだけを実装し、planner / save のBLOCKは維持する。保存経路への適用はF3 |
| hardSafety（将来の出典付き上限） | CoachOverride（理由 + 二重確認）。`nonOverridable` 指定のものは不可 |

判断: [ENGINE-POLICY]（Fable「override は人間 role 限定・ログ必須」を型で実装）。

### 8.4 競技団体ガイドライン（context-only）
- Sports Agency「部活動改革及び地域クラブ活動の推進等に関する総合的なガイドライン」（令和7年12月）の休養日・活動時間 guidance は、**日本の学校部活動および適用対象の認定地域クラブ**に限る context-specific guidance として EvidenceRecord に保持する。
- `ageBand=U15`、日本語利用者、または AI の文章だけから institutional context を推定してはならない。現行 MVP は trusted institutional context input を持たないため、週次 runtime へ自動適用しない。
- 旧 JSPO growth guidance の正確な primary attributionは保持せず、pain gate の非診断的な安全挙動は `ENGINE_SAFETY_POLICY` として実装する（§13.2）。

### 8.5 Plausibility（rs-2026.09.0）[ENGINE-POLICY・provisional]

| 対象 | REQUIRE_CONFIRMATION | BLOCK |
| --- | --- | --- |
| 1本の距離（ACC/MV合計/SES/RS/AS/STRIDE） | > 150 m | > 300 m |
| 1本の距離（LONG） | > 600 m | > 1000 m |
| 1本の距離（TI。TEは固定template上300m以下） | > 400 m | > 1000 m |
| buildUpM（MV/AS） / flyZoneM（AS。MVは固定template） | > 70 / > 40 | > 120 / > 80 |
| SESの1本の時間（TIは距離方式） | > 20 s | > 120 s |
| repsPerSet / sets / totalReps | > 12 / > 6 / > 30 | > 30 / > 20 / > 80 |
| repRestS / setRestS | > 2400 / > 3000 | > 3600 / > 5400 |
| 1項目の総走行距離 | > 3000 m | > 10000 m |
| メニュー全体の総走行距離（§11） | > 8000 m | > 30000 m |
| sets/reps 取り違え疑い | `totalReps ≥ recommended.totalReps.max × 3` | — |
| 入力: 100m 記録 | < 9.0 s または > 25 s | < 5 s または > 60 s |
| 入力: fly 10m | < 0.80 s または > 2.5 s | < 0.5 s または > 5 s |
| 入力: 身長 | < 100 cm または > 220 cm | < 50 cm または > 260 cm |

- RuleSet は閾値の各側に machine-readable policy を持つ。距離・build/fly・duration の F01–F06 は METHOD_POLICY_HARD（選択した方法・型の定義であり、生理学的または安全上の絶対限界ではない）。STRIDE >300m は「このエンジンでは300m超をSTRIDEとして扱わない」という方法定義。
- reps/sets/総本数/rest/項目総距離の F07–F12 は COACH_OVERRIDABLE_STRONG_REVIEW。menu総距離 F13 は PRODUCT_DATA_SANITY_HARD。F14/F15 は下限違反を NON_OVERRIDABLE_DATA_SANITY_HARD、上限違反を COACH_OVERRIDABLE_STRONG_REVIEW とし、F16の正値範囲外は選択された成長端点だけを DATE_AWARE_COACH_OVERRIDABLE_STRONG_REVIEW とする。F1/F2ではreview requestをplannerへ接続しないため、これらreview対象もBLOCKのまま保存を止める。
- 区間閾値は scalar比較へ潰さない。MAX L は `lower > L` を CONFIRMED_EXCEED、未確定で `upper > L` を POSSIBLE_EXCEED、`upper <= L` を CONFIRMED_WITHIN、それ以外を UNEVALUABLE とする。MIN は対称。等値は違反でない。POSSIBLE_EXCEEDとUNEVALUABLEはそれぞれ構造化Findingを出し、F1では安全側にBLOCKする。
- F14/F15は今回選ばれた参照記録だけを入力境界判定する。未選択の過去記録はDATA_QUALITYへ隔離し、無関係な計画をBLOCKしない。日付・形状・非正値は既存の構造検証で拒否する。F16では未来点を成長計算から除外し、未選択の正値外れ点はDATA_QUALITYとする。
- OPEN20 Phase 4B-F2の `PlausibilityIssue` は `ruleId` / `findingCode` / scope / target / scalar-or-interval observation / boundary side + threshold / certainty / RuleSet version + contentHash / current context digestを含む。issue digestはこれらのcanonical JSONをSHA-256し、object key順に依存しない。array indexでtimed markやheight pointを識別しない。F14/F15はsubject identity・event・date・time・timing methodで、F16はsubjectまたはmember identity・date・heightでrecord digestを作る。
- F2.1ではreview contextを部分JSONで受けず、validated `PlanRequest` と出力findingの現在処方からdomain helperがsemantic projectionを構築する。処方のrep構造・sets/reps・rests・intensity/reference・距離/時間/approach等を含み、表示label・配列挿入順・一時時刻は含めない。選択されたtimed mark / height findingはfinding内にsource identityを保持し、builderは完全一致する現request内のrecordだけを再解決する。group memberには後方互換optionalなstable `memberId` を使い、無いmemberの身長reviewはfail closed。
- F2 closureでは `review-context.ts` にschema由来の全key inventoryを集約する。rep / intensity referenceのexhaustive switch + `assertNever`、optional keyを含むmapped projectionにより、新variant / semantic fieldの未対応をtypecheckで検出する。FieldValueはvalueだけでなくunit・recommended/coachEditable/hardSafety・position/originを、区間はlower/upper/unit/source/confidenceを保持する。共通部分はsets/reps（totalRepsは積）・全rest・intensity/reference・exposure・tier・recovery・monitoringの実行条件・confidence・readiness/safety・loadSnapshot・planningControls・RuleSetを拘束する。coach editのunit、overrideのtarget/value/confirmation、計画日時・履歴・大会・他項目も含む。`plannedAt` は48h/72h評価に影響する予定時刻なのでUTC instantへ正規化して拘束する（creation/audit時刻とは別）。

| Rep variant | canonical review contextに含むsemantic fields |
| --- | --- |
| DISTANCE | kind、distanceMの全FieldValue semantics |
| DURATION | kind、durationSの全FieldValue semantics、displayDistanceMの全区間（exposureが未更新でも独立に拘束） |
| SPLIT | kind、順序付きsegments、各distanceM / restAfterS |
| FLY | kind、buildUpDistanceM / flyZoneDistanceM、decelerationDistanceM、totalRunningDistanceM、plannedHighSpeedExposureMの全区間（nullも保持） |
| ATTEMPTS | kind、approach、approachDistanceMのvalue / unit / source（未入力nullも区別） |

- citation、localized説明、group表示label、derived Finding/rationale、generatedByやoverrideの監査時刻はcontext identityに含めない。`COACH_DEFINED.label` は唯一の処方指示本文なので例外としてsemanticに含める。集合的な配列はcanonical sortするが、split順、同日recordの選択tie priority、first-match分類bandなど実行結果を変える順序は維持する。重複field edit / 同target overrideは曖昧なためreview contextを拒否する。非有限数値もfail closed。
- source recordの存在確認だけでは選択済みとみなさない。input Findingは現在request・RuleSetでplannerを再評価し、source identityを含め一意一致するものだけをissue化する（旧Fly10がraw marksに残っていても、直接Vmax等へ選択が移れば拒否）。outputも現在処方からFindingを再計算する。review validatorはINPUT / OUTPUT両方を再計算したissueと照合し、古いFinding、本文を再hashした偽issue、F14の存在しないselected runtime pathを受け付けない。F14 MAXの表現はdomain policy builderでのみ検証し、MIN hardは常にreview不可。
- F2のreview requestは `issueDigest`・理由（trim後10〜1000文字）・二つの `true` confirmationだけを受ける。serverは現在のplan finding、RuleSet、contextから作ったissueを一意照合し、actorと時刻をserver側で付けた `AppliedPlausibilityReview` を返す。F07–F15の `COACH_OVERRIDABLE_STRONG_REVIEW` と、F16選択端点の `DATE_AWARE_COACH_OVERRIDABLE_STRONG_REVIEW` だけをreview対象にする。hard / product-data / data-quality / unevaluable finding、古い値・context・RuleSet、未一致または重複digestは拒否する。
- Provenance parse時はAppliedReviewのissue identityを再canonicalize / SHA-256再計算し、保存digestとの一致を必須にする（reason / actor / timestamp / confirmationはissue identity外）。optional `plausibilityReviews` はschemaVersion 1のまま追加し、旧データのfield欠落を許容する。同一issueDigest重複は拒否し、各reviewのRuleSet identityは親provenanceと一致させる。UTF-8 16KB上限を維持する。F2/F2.1では通常saveからreviewsを書かず、reviewでPLAN_BLOCKEDを解除せず、Menu→Sessionへ伝播せず、UI / AI authorityを追加しない。これらのruntime適用はF3以降。
- 監査 C-1 の「ペース走 80km」は項目 BLOCK と Session BLOCK の二重で止まる。「インターバル 25.6km」は項目 BLOCK（> 10000m）。

---

## 9. Planning Engine

### 9.1 入出力

```ts
export type PlanRequest = {
  selection: RunningSelection;                     // method + templateId（型で整合）
  subject: Subject;
  menuContext: {
    phase: TrainingPhase | null;
    plannedDate: IsoDate | null;                   // 無い場合、週次・大会評価は "NOT_EVALUATED"
    competitions: CompetitionRef[];                // §14
    otherItems: PlannedItemSummary[];              // 同メニュー内の既存項目（集計用）
    availableMinutes: number | null;
  };
  history: LoadEvent[] | null;                     // 直近 ≥72h。null = 未提供
  readiness: ReadinessDecision | null;             // §13（GROUP 計画時は通常 null）
  positionPreference: "LOWER" | "MIDDLE" | null;   // AI が指定できるのはこれだけ
  coachEdits: CoachFieldEdit[];                    // コーチ入力（COACH_EDITABLE 内）
  overrides: CoachOverride[];
  actor: Actor;
};

export type PlanResult =
  | { status: "OK"; prescription: RunningPrescription; sessionFindings: Finding[] }
  | { status: "INELIGIBLE"; reasons: EligibilityReason[]; substitutes: RunningSelection[] }
  | { status: "BLOCKED"; findings: Finding[] };    // plausibility / safety / infeasible
```

- `ruleSetVersion` は PlanRequest に**含めない**（サーバーが `getActiveRuleSet(plannedDate ?? today)` で決める）。テスト用に loader を差し替える口だけ用意。[ENGINE-POLICY]
- **[R4 errata]** 入出力は次のとおり確定する（`src/domain/running/planning/schema.ts` の Zod が正）:
  - `planningDate: IsoDate` を追加（必須・実在する日付）。RuleSet の選択（`getActiveRuleSet(planningDate)`）・ageBand・記録の鮮度の
    評価基準日。`menuContext.plannedDate` は null 可、非 null なら `planningDate` と一致しなければならない。domain は
    `Date.now()` / `new Date()` を使わない（上の `plannedDate ?? today` はサーバー側が planningDate を決める規則として読む）。
  - `ruleSetVersion` は `.strict()` で拒否する。処方には `ruleSet: { version, contentHash, status }` を埋め込み、contentHash は
    検証済み `manifest.json` から取る（domain で hash を再計算しない）。
  - `coachReference: CoachReferenceInput | null` を追加。`IntensityReference` のうち `RACE_PACE` / `TARGET_SPLIT` /
    `VELOCITY_DECREMENT` / `COACH_DEFINED` だけを受け付ける（MEASURED_VMAX / FLY_SPLIT / SAME_DISTANCE_BEST をコーチ入力で偽装させない）。
    目標区間の lower / upper は正の有限値必須。kind は MethodMeta（allowedIntensityReferences + intensityFallback）で許可されている
    必要があり、VELOCITY_DECREMENT の band は `SessionTemplate.resistanceBand` と一致しなければならない（band を持たない template では使えない）。
  - actor が AI_PLANNER / SYSTEM のとき `coachEdits=[]`・`overrides=[]`・`coachReference=null`（schema で拒否）。COACH の actor と
    `overrides[].actor` は branded `CoachActor`（認証ではない）で、ownerId が一致しなければならない。
  - **[R4 transitional restriction]**（最終的な PlanRequest contract ではない。R5 / R6 / R7 の型を先行実装しないための暫定制限）:
    `readiness` は R5 の `ReadinessDecision` 型が未実装のため **`null` 固定**（非 null を黙って無視すると pain gate を素通りさせるため拒否。
    **R5 で開放**）。`menuContext.otherItems` は **R6 で開放**、`menuContext.competitions` は **R7 で開放**（それまで空配列のみ）。
    `history`（R1 の `LoadEvent[]`）と `menuContext.phase` は既存の型で安全に受け取れるため受け付けるが、R4 では評価しない（中立。
    週次・履歴・phase の評価は **R7 で接続**）。
  - `CoachFieldEdit = { field: EnvelopeField | "approachDistanceM"; value: number（有限）; unit: Unit }`（strict・field 重複不可）。
    field は選択した template の Envelope に存在し、その処方で実際に使われなければならない（使われない edit は BLOCKED
    `COACH_EDIT_NOT_APPLICABLE`）。`approachDistanceM` は EVENT_APPROACH_SPEED だけ。同じ field に edit と FIELD override は併用不可。
  - `CoachOverride` は §8.3 の型どおり（reason はトリム後 10 文字以上、ELIGIBILITY / HARD_SAFETY は confirmedTwice=true、
    FIELD は newValue 必須、ELIGIBILITY は newValue 不可）。ELIGIBILITY override の ruleId は INELIGIBLE の原因として報告された id
    （EligibilityRule.ruleId / ConstraintRule.id / R4 の advancedOnly gate id `ADVANCED_ONLY:<templateId>` — templateId から組み立てる
    識別子で、文字列を解析しない）でなければならない。`EligibilityRule.conditions.whenUnmet = INELIGIBLE_NON_OVERRIDABLE` による不適格
    （reason `ELIGIBILITY_CONDITIONS_UNMET`、ruleId はその EligibilityRule の id）は常に override 不可。
  - `PlanResult`:
    ```ts
    type PlanResult =
      | { status: "OK"; prescription: RunningPrescriptionValue; sessionFindings: Finding[] }
      | { status: "INELIGIBLE"; reasons: EligibilityReason[]; substitutes: RunningSelection[]; findings: Finding[] }  // findings を追加
      | { status: "BLOCKED"; findings: Finding[] };
    ```
    INELIGIBLE の `findings` を追加し、§6.2 の「DRAFT fallback 時は全出力に `RULESET_DRAFT`（INFO）」を満たす（RuleSet を選んだ後の
    OK / INELIGIBLE / BLOCKED はすべて RULESET_DRAFT を持つ。PlanRequest が parse できず RuleSet 選択前に BLOCKED になる場合は付けない）。
    責務: 不適格の**理由そのもの**は `EligibilityReason`、結果の種類に依らない**横断情報**（RULESET_DRAFT、PHASE / WEEKLY の
    NOT_EVALUATED、入力確認など）は `Finding`。同じ内容を二重化しない。
    `sessionFindings` は R6 まで常に `[]`、`substitutes` は R4 では `[]`。PlanRequest が schema を満たさない場合は例外にせず
    `BLOCKED`（`PLAN_REQUEST_INVALID`）。
  - `EligibilityReason = { code; ruleId: string | null; overrideAllowed: boolean | null }`。

### 9.2 最終 Pipeline（レビュー済み・確定）

候補案からの変更点:
1. plausibility を **入力（step 1）と出力（step 14）に分割**
2. **CONFIDENCE & DIRECTNESS DERIVATION（step 10）を追加**（数値の位置決めに必要なため個別化の直後）
3. readiness を **pain gate（step 2）と非 pain の action（step 11）に分割**
4. **HARD SAFETY RE-CHECK を出力直前（step 13）に追加**（coach edit / override 後の再検証）
5. Stop Rule は pipeline に置かず、template の `stopPolicyId` を**参照として付けるだけ**（評価は §10）

| # | Step | 関数 | 決めること | 失敗時 |
| --- | --- | --- | --- | --- |
| 1 | INPUT NORMALIZATION + INPUT PLAUSIBILITY | `normalizePlanRequest` | 単位統一、Zod、記録の鮮度、入力 plausibility | BLOCKED |
| 2 | SAFETY / PAIN GATE | `applyPainGate` | readiness に pain/red flag があれば高強度を除外 or 全停止 | INELIGIBLE / BLOCKED |
| 3 | AGE BAND + MATURATION + TRAINING AGE CONSTRAINTS | `resolveSubjectProfile` | ageBand、実効 maturity、trainingAge tier、EnvelopeTier、許可集合 | — |
| 4 | COMPETITION PRIORITY / PHASE | `resolveCompetitionAndPhase` | 大会近接ウィンドウ、methodPriority、eligibility、volumeTarget 位置 | — |
| 5 | RECENT TRAINING / WEEKLY CONTEXT | `evaluateWeeklyContext` | 48h/72h、全カテゴリ、履歴カバレッジ | — |
| 6 | METHOD ELIGIBILITY | `evaluateEligibility` | 3〜5 と MethodMeta・データ有無の積集合 + 理由 | INELIGIBLE（代替候補付き） |
| 7 | METHOD + SESSION TEMPLATE SELECTION | `validateSelection` | 要求された selection の検証、advancedOnly、complexity、recoveryStructure | INELIGIBLE |
| 8 | POPULATION-SPECIFIC EVIDENCE ENVELOPE | `selectEnvelope` | tier × template の Envelope、制約による範囲の絞り込み | BLOCKED（ENVELOPE_INFEASIBLE） |
| 9 | PERFORMANCE-BASED INDIVIDUALIZATION | `individualize` | 参照解決（§4.6）、目標タイム区間、露出区間 | — |
| 10 | CONFIDENCE & DIRECTNESS DERIVATION | `deriveConfidence` | directness、prescriptionConfidence、位置の上限 | — |
| 11 | READINESS ACTION | `applyReadinessAction` | NO_CHANGE〜SWAP の反映（§13） | INELIGIBLE（SWAP 時は代替） |
| 12 | VALUE PLACEMENT | `placeValues` | position → 値（§7.3）、coachEdits と overrides の適用 | BLOCKED |
| 13 | HARD SAFETY RE-CHECK | `recheckHardSafety` | override の妥当性、nonOverridable の再確認 | BLOCKED |
| 14 | SESSION AGGREGATION + OUTPUT PLAUSIBILITY | `evaluateSessionAggregation` + `checkOutputPlausibility` | otherItems と合わせた累積判定 | BLOCKED / Finding |
| 15 | PRESCRIPTION OUTPUT | `buildPrescription` | rationale、evidenceIds、ruleSet 情報、generatedBy | — |

- 順序の理由（抜粋）: 制約（3〜7）を数値決定（8〜12）より前に置き、AI やコーチ入力が不適格 Method を選べないようにする。大会（4）を週次（5）より前に置くのは、大会の race が週次の負荷イベントになるため。[ENGINE-POLICY]

### 9.3 位置（position）の決定規則 [ENGINE-POLICY]

候補を集め、**最も低い位置を採用**する（順序: LOWER_BOUND < LOWER_HALF < MIDDLE < UPPER_HALF）。

| 由来 | 位置の上限 |
| --- | --- |
| phase / competition（§14） | PREPARATION=UPPER_HALF, PRE_COMPETITION=MIDDLE, COMPETITION=LOWER_HALF, TRANSITION=LOWER_BOUND, 大会ウィンドウ内は §14.3 |
| prescriptionConfidence（§5.5） | HIGH=制限なし, MODERATE=MIDDLE, LOW/POLICY_ONLY=LOWER_HALF |
| readiness（§13） | USE_LOWER_BOUND=LOWER_BOUND |
| AI の positionPreference | LOWER=LOWER_HALF, MIDDLE=MIDDLE |
| 未指定の既定 | MIDDLE |

- **rest 系フィールドだけは逆向き**: `INCREASE_REST` のとき rest を `UPPER_HALF` に置く。それ以外の由来で rest を短くしない（rest の位置は常に MIDDLE 以上）。[ENGINE-POLICY]

### 9.4 Rest の計画（distance × 固定秒は禁止）

```ts
export type RestPlan = {
  repRestS: FieldValue<"s">;
  setRestS: FieldValue<"s"> | null;
  intraRepRestS: FieldValue<"s"> | null;     // LONG INCOMPLETE のみ
  displayAsFloor: true;                      // 「最低この時間は空ける」と表示
  feasibility: "OK" | "EXCEEDS_AVAILABLE_TIME" | "UNKNOWN";
};
```

- 入力: method、template（= 1本の時間の目安）、EnvelopeTier、performance（参照の有無は confidence 経由でのみ影響）、目的（template）。
- 出力値は Envelope の `repRestS` / `setRestS` から §9.3 の位置で置く。**計算式を持たない。** [ENGINE-POLICY]
- UKA「疾走1秒につき1–2分」は youth 20m 約2分の例と整合しないため、**rs-2026.09.0 では生成にもチェックにも使わない**。[OPEN-14]
- 「10m=60秒」は使わない。[SOURCE-BACKED 否定: 全DR]
- **[R4 errata]** `feasibility` の R4 と R6 の責務境界: R4（1項目）は、**mandatory な rest（＋時間が確定している走行時間:
  DURATION rep の時間、TARGET_SPLIT の目標下限の合計）だけで** `availableMinutes` を明らかに超えるときだけ `EXCEEDS_AVAILABLE_TIME`
  （WARN `REST_INFEASIBLE_FOR_PRACTICE`）。移動・準備・走行時間が不明な rep・同じメニューの他項目を含む総所要時間は R4 では確定しないため、
  収まりそうでも `OK` と断定せず `UNKNOWN`（`availableMinutes = null` も `UNKNOWN`）。rest + 走行時間 + 他項目の評価は R6 の
  Session Aggregation が行う。rest を時間不足に合わせて短縮しない原則は変えない。

### 9.5 個別化（目標値は区間で出す）[ENGINE-POLICY]

| 参照 | 目標の出し方 | 出力 |
| --- | --- | --- |
| MAX_INTENT | 数値目標なし。評価はセッション内ベスト比較（§10） | `target: null` |
| MEASURED_VMAX / FLY_SPLIT（MV） | 目標は「全力」。Vmax は露出区間とテンポ換算にのみ使う | `target: null` |
| MEASURED_VMAX（TE） | 1本の目標時間 = `distance / (v × p)`、v は [lower, upper]、p は intensity の [min, max] | `QuantityInterval<"s">` |
| SAME_DISTANCE_BEST | 目標時間 = `best / p`（p の区間） | `QuantityInterval<"s">` |
| RACE_PACE / TARGET_SPLIT | コーチ入力値をそのまま区間化 | `QuantityInterval<"s">` |
| RELAXED_SUBMAX | 数値なし | `target: null` |

- 丸め: HAND/UNKNOWN 由来は 0.1秒、それ以外は 0.01秒。区間は外側に丸める。
- 目標タイムは **ATHLETE subject のときだけ**出す（GROUP では出さない）。
- **[R4 errata]** 個別化の実装で確定した事項:
  - 参照は MethodMeta.allowedIntensityReferences（→ intensityFallback）の順で、R3 `resolveReference()` の解決ロジック（鮮度・
    計時法・fly split 区間）を1 kind ずつ再利用して決める。100m PB → Vmax は推定しない。
  - MEASURED_VMAX: `athlete.vmax` を優先。FLY_SPLIT を別 kind に持たない Method（TE / TI / SES / ASSISTED）では、fly 記録から
    R3 が導出した VelocityEstimate（source=FLY_SPLIT_*）も MEASURED_VMAX として使う（T-MISS-03）。FLY_SPLIT の区間距離は
    `eventDefinitions.timedMarks`（segment=FLY_ZONE）の distanceM。
  - SAME_DISTANCE_BEST は rep と同じ距離の記録だけ（距離は `eventDefinitions` から読む。template の displayDistanceM、LONG は
    template.primaryEvents のハードルでないレース種目の距離）。R3 の方針どおり 100m 記録は同距離 best に使わない。
  - **SAME_DISTANCE_BEST から数値 target を生成するのは、該当 Envelope に versioned な `intensityPercent` の範囲が存在する場合のみ**
    （target = best / p）。`intensityPercent` セルを持たない Method（SES / LONG）では reference は保持するが `target = null`。
    p の値（95% 等）を Method 名や経験則から推測しない。MEASURED_VMAX の `distance / (v × p)` も同じ。
  - RACE_PACE / TARGET_SPLIT は target にコーチ入力をそのまま入れる（TARGET_SPLIT は区間の合計）。丸めない。RACE_PACE の表示距離は
    `eventDefinitions.raceEvents` の distanceM × 時間 ÷ 目標タイムの区間。
  - VELOCITY_DECREMENT は plan 時に専用 `vdecClassificationPolicy` snapshot だけを保存する。観測値は LIGHT / MODERATE / unresolved review / VERY_HEAVY に分類するが、分類から sled load・推奨 Vdec target・intensity prescription を生成しない。旧 numeric target snapshot は読み取り互換のみ。
    ASSISTED_SPRINT はコーチ入力の intensityPercent を percent target として出す。NOT_REQUIRED の参照は target を持たない。
  - LONG: FULL で TARGET_SPLIT のときは SPLIT rep（区間距離はコーチ入力、合計目標時間は repDurationS の範囲で検査）、RACE_PACE /
    SAME_DISTANCE_BEST のときは DURATION rep（表示距離は時間×速度の区間。同距離 best は下端 null）。INCOMPLETE は 2 区間以上の
    TARGET_SPLIT が必須（無ければ INELIGIBLE `REFERENCE_UNAVAILABLE`）で、区間休息は intraRepRestS。
  - EVENT_APPROACH_SPEED の SHORT / FULL は `SessionTemplate.approachType` から読む。
  - 目標値の区間計算（§9.2 step 9）は、template 固定値・位置で置いた rep 距離が決まった後（step 12 の後）に行う。

---

## 10. Runtime Monitoring

### 10.1 入出力

```ts
export type RepObservation = {
  setIndex: number; repIndex: number;
  timeS: number | null;
  timing: TimingMethod;
  videoFps?: number | null;
  measuredVelocityMps?: number | null;
  actualHighSpeedExposureM?: QuantityInterval<"m"> | null;
  restTakenS?: number | null;
  coachJudgment?: {
    technique?: "GOOD" | "ACCEPTABLE" | "DETERIORATING" | "UNSAFE";
    startQuality?: "GOOD" | "POOR";
    environmentUnsafe?: boolean;
  } | null;
  athleteReport?: { painNow: boolean; painRegion?: BodyRegion | null; redFlags?: RedFlag[]; requestsStop?: boolean } | null;
};

export type MonitorDecision = {
  action: "CONTINUE" | "EXTEND_REST" | "END_SET" | "END_SESSION_QUALITY" | "STOP_SAFETY" | "COACH_REVIEW";
  safetyOutcome: SafetyOutcome;
  nextRepRestS: Range<"s"> | null;
  quality: "PASS" | "FAIL" | "NOT_EVALUATED_COACH_ONLY";
  consecutiveFailures: number;
  reasons: StopReason[];
  logEntry: RepLogEntry;          // SessionItem.actualRepLogJson に追記（痛みの部位は含めない §13.5）
};

export function monitorRunningPrescription(state: MonitorState, obs: RepObservation): MonitorDecision;
```

- `MonitorState` = SessionItem のスナップショット（`plannedPrescriptionJson`）+ これまでの `RepLogEntry[]`。**ルールセットを再読込しない**（ただし timing tolerance と stop policy は スナップショット時点の値を `prescriptionJson.stopPolicy` に埋め込んでおく §17）。

### 10.2 Timing tolerance [ENGINE-POLICY・provisional]

以下の数値は計測器・実装の運用 convention であり、普遍的に検証された科学的許容限界ではない。特に `VIDEO = 2 / fps` は engineering convention で、一次資料から universal tolerance として導出しない。

| timing | tolerance | 数値 stop |
| --- | --- | --- |
| HAND | 0.25 s（距離依存項は OPEN-03 のため 0） | 可（下記比率条件） |
| PHOTO_CELL | 0.05 s | 可 |
| FAT | 0.05 s（専用値は OPEN-03） | 可 |
| VIDEO | 2 / fps s（fps 未入力は UNKNOWN 扱い） | 可 |
| RADAR_LASER | 未定義（OPEN-04） | **COACH_ONLY** |
| UNKNOWN | — | **COACH_ONLY** |

- 追加条件: `tolerance / 参照タイム > 0.10` のとき **COACH_ONLY**（例: HAND の fly 10m ≈ 1.1秒 → 23% → 数値判定しない）。
- すべて `EV_ENGINE_POLICY`（provisional）＋ `EV_TIMING_ERROR_REPORTS`（CHECK_ONLY）を紐付ける。Fable の値は**確定値として扱わない**。
- `universalDropoffPercent` は存在しない（null 固定）。[SOURCE-BACKED: 4DR が普遍閾値なしと報告]

### 10.3 Stop policy（Method × recoveryStructure）

**全 Method 共通（最優先・どの条件でも緩まない）**: `painNow` / `redFlags` / `requestsStop` / `technique=UNSAFE` / `environmentUnsafe` → `STOP_SAFETY`。phase・tier・recoveryStructure で緩めない。[ENGINE-POLICY]

「FAIL」= `timeS > 参照 + tolerance`。「2回連続」は provisional。[ENGINE-POLICY]（Perplexity DR の consecutiveFailedReps=2 を採用）

| stopPolicyId | 対象 | 参照 | 判定 |
| --- | --- | --- | --- |
| SP_ACC | ACCELERATION | セッション内の同距離ベスト | 1回目 FAIL → EXTEND_REST（1回まで）。2回連続 FAIL → END_SESSION_QUALITY。startQuality=POOR 2回連続 → COACH_REVIEW |
| SP_MV | MAX_VELOCITY | セッション内 fly ベスト | SP_ACC と同じ |
| SP_SES | SPRINT_ENDURANCE_SHORT | 目標区間の上端（無ければセッション内ベスト） | 2回連続 FAIL → END_SESSION_QUALITY |
| SP_LSR_FULL | LONG FULL（全対象） | 目標スプリット上端 | 2回連続 FAIL → END_SESSION_QUALITY |
| SP_LSR_INCOMPLETE_ADV | LONG INCOMPLETE（POST+ADVANCED のみ） | 目標スプリット上端 | 分割走内の低下では止めない。2回連続で目標超過 → COACH_REVIEW。共通 hard stop は有効 |
| SP_LSR_INCOMPLETE_STRICT | LONG INCOMPLETE を override で他者に処方した場合 | 同上 | **SP_LSR_FULL と同じ**（疲労許容ロジックを適用しない） |
| SP_TE | TEMPO_EXTENSIVE | 目標区間（あれば） | 数値 stop なし（COACH_ONLY）。目標下端より速すぎが2回 → WARN「テンポの目的外」 |
| SP_TI | TEMPO_INTENSIVE | 目標区間 | 2回連続 FAIL → END_SET |
| SP_RS | RESISTED_SPRINT | 実測 vdec（あれば） | band 外 → COACH_REVIEW（負荷調整） |
| SP_AS | ASSISTED_SPRINT | — | technique ≠ GOOD → STOP_SAFETY |
| SP_EA | EVENT_APPROACH_SPEED | — | COACH_ONLY。attempts 上限到達 → END_SESSION_QUALITY |
| SP_STRIDE | STRIDE | — | 数値 stop なし。コーチの「全力化」判定 → COACH_REVIEW |

- 判断: 「LONG で疲労を目的に含むため Vmax 低下だけで止めない」は [SOURCE-BACKED]（ChatGPT DR）。「止めない設計を POST+ADVANCED に限定」は [ENGINE-POLICY]（Fable C-7・要件§14）。
- **技術評価はコーチ入力のみ**（`COACH_JUDGMENT`）。エンジンは推定しない。AI の生成文に「フォームが崩れたら中止」を出させない（§18）。[ENGINE-POLICY]（Fable M-4）
- **[R4 errata]** plan 時の stop policy の選択は、MethodMeta.stopPolicyIds のうち method・`appliesToRecoveryStructure` が一致し、
  `StopPolicy.appliesToEligibilityPath` が処方経路に適用されるものを一意に選ぶ（policy id の文字列では選ばない）:
  `ANY` = 経路に依らない／`AUTO_CONDITIONS_MET` = override なしで eligibility が AUTO（構造化条件を満たす）だった処方
  （rs-2026.09.0 では SP_LSR_INCOMPLETE_ADV）／`MANUAL_OR_OVERRIDE` = 手動選択・override 経由の処方（SP_LSR_INCOMPLETE_STRICT）。
  選ばれた policy の行と全 TimingTolerance の行は `RunningPrescription.monitoringSnapshot` にコピーする（§17.1-5）。

### 10.4 Runtime pipeline（確定）

候補からの変更: 痛み・危険兆候を**タイミング判定より前**に移動（計時が無くても止められるように）。

```
1 OBSERVATION NORMALIZATION（Zod）
2 SAFETY GATE（pain / red flag / 本人の中止要請 / UNSAFE / 環境）      → STOP_SAFETY
3 TIMING RELIABILITY（§10.2。COACH_ONLY 判定）
4 PERFORMANCE vs REFERENCE（stopPolicyId × recoveryStructure）          → EXTEND_REST / END_*
5 COACH JUDGMENT（technique / startQuality）                          → COACH_REVIEW
6 CUMULATIVE CHECK（予定本数到達、実測露出が集計上限超過）             → END_SESSION_QUALITY / COACH_REVIEW
7 DECISION + RepLogEntry
```

### 10.5 休息延長と実測露出 [ENGINE-POLICY]
- `EXTEND_REST` は1本につき1回まで。延長後の rest は `repRestS.coachEditable.max` を超えない。
- 実測露出: `actualHighSpeedExposureM` が MEASURED で来たら採用。来なければ **planned の区間を `source: "PLANNED"` でコピー**（完了した本数分のみ）。null を 0 にしない。

### 10.6 [R8 representation errata]（R8 実装で確定した表現）

§10.1〜§10.5 の意味は変えず、実装上の表現だけを次のとおり確定する（`src/domain/running/monitoring/` と
`src/domain/running/types/monitoring.ts` の Zod が正）。

- **monitor は RuleSet を読まない。** `MonitorState = { prescription, priorLogs }`。判定に使う policy は
  `prescription.monitoringSnapshot`（`stopPolicy` / `timingTolerances` / `safetyPolicy`）だけで、RuleSet の version / hash を
  別に受け取らない。処方の再生成・Envelope の再選択・athlete context / weekly / competition / readiness / phase の再評価をしない。
  永続化もしない（`actualRepLogJson` 等への保存は R11）。
- **StopPolicy の機械可読化（`StopPolicy.runtime`）。** R2〜R7 の StopPolicy は挙動を `ruleDescriptionJa`（自然文）にしか
  持たず、policy id やテキストを解析しないと判定できなかった。R8 で次を追加する（値は §10.3 の表の言い換えのみ。既存の
  `consecutiveFailuresToStop` / `numericStopAvailable` / 説明文 / 全 TimingTolerance は不変）:
  `timingEvaluation`（SLOWER_THAN_REFERENCE_FAILS / FASTER_THAN_TARGET_LOWER_WARNS / NONE）、`reference`
  （PRIOR_SESSION_BEST / TARGET_UPPER / TARGET_UPPER_ELSE_PRIOR_SESSION_BEST / TARGET_LOWER / NONE）、`firstFailureAction`、
  `consecutiveFailureAction`、`tooFastConsecutiveThreshold`（TE）、`poorStartConsecutiveThreshold`（ACC/MV）、
  `techniqueDeterioratingAction`、`techniqueNotGoodAction` / `techniqueMissingAction`（AS）、`velocityDecrementOutOfBandAction`（RS）、
  `effortBecameMaximalAction`（STRIDE）、`plannedCountUnit`（REPS / ATTEMPTS）。`numericStopAvailable` などとの矛盾は schema で拒否する。
  SP_LSR_INCOMPLETE_ADV と SP_LSR_INCOMPLETE_STRICT の差は `consecutiveFailureAction`（COACH_REVIEW / END_SESSION_QUALITY）だけで表す。
- **Safety gate（最優先）と safetyOutcome。** `painNow` / `redFlags` / `requestsStop` / `technique=UNSAFE` / `environmentUnsafe`
  のどれかで STOP_SAFETY（timeS=null でも）。safetyOutcome は、red flag なら snapshot の `safetyPolicy.redFlagGroups` の
  該当グループのうち最大 severityRank、red flag なしの痛みは `safetyPolicy.painPresentOutcome`、本人の中止要請・UNSAFE・環境・
  ASSISTED の技術は健康情報に由来しない中止として **COACH_REVIEW**（対応する RuleSet 行が無く、readinessRules は変更しない
  ため contract として固定）。複数該当は最も重い outcome。
- **RepObservation の追加フィールド。** `measuredVelocityDecrementPercent`（0–100）: RS の vdec。処方 snapshot に無抵抗時の
  基準速度が無いため `measuredVelocityMps` から計算しない。`coachJudgment.effortBecameMaximal`: STRIDE の「全力化」判定
  （DETERIORATING 等を全力化と読み替えない）。setIndex / repIndex は 1 始まり。1つの観測は「実施した1本」を表す。
- **VIDEO の fps 矛盾の解消。** §19.1 の「VIDEO なら fps 必須」を撤回し T-TIM-05 を採用: fps が無い / null の VIDEO は
  schema で拒否せず、正規化で effective timing を UNKNOWN に落として COACH_ONLY。fps があれば tolerance = `toleranceSPerFps / fps`。
- **参照タイムと参照候補。** 2つの概念を1つの boolean に潰さない:
  - **isReferenceCandidate**（その本のタイムが time-domain で有効な計測か）: 数値 tolerance が定義される effective timing
    （HAND / PHOTO_CELL / FAT / fps のある VIDEO）でタイムがあり、**STOP_SAFETY の本ではない**こと。quality とは独立で、
    **比率条件で COACH_ONLY になった本も候補に含める**（例: HAND fly10 の真のベスト 1.10 秒を候補から外すと、後の遅い 2.6 秒が
    参照になり突然数値 stop が効いてしまう）。`effectiveTiming=UNKNOWN`（timing=UNKNOWN・fps 無し VIDEO）、時間 tolerance が
    定義されない RADAR_LASER（速度 policy とは別）、STOP_SAFETY の本は候補にしない。FAIL の本も候補（ベストを更新しないだけ）。
  - **isNumericStopEvaluable**（今回の本を参照と数値比較して PASS / FAIL を出してよいか）: 今回の本が time-domain の計測であり、
    `tolerance / 参照 ≤ coachOnlyRatioThreshold`。
  - `PRIOR_SESSION_BEST` = 同じ処方のこれまでのログのうち、同じ effective timing の参照候補のタイムの最小値（今回の本は含めない。
    HAND と PHOTO_CELL を混ぜない）。候補が無い最初の本は **「参照の確立」**（quality=PASS、reason REFERENCE_ESTABLISHED、
    referenceTimeS=null）であり、自分自身に対して架空のベストを作って FAIL 判定しない。ただし自分のタイムに対する比率条件を
    満たさなければ COACH_ONLY（それでも以降の参照候補にはなる）。`TARGET_UPPER` = snapshot の `intensity.target`（秒）の上端。目標が無ければ
  COACH_ONLY（NO_NUMERIC_REFERENCE。PB 等から再推定しない）。`tolerance / 参照 > coachOnlyRatioThreshold` は COACH_ONLY
  （ちょうど等しいのは数値評価）。FAIL = `timeS > 参照 + tolerance`（等しいのは PASS）。
- **連続判定。** 連続 FAIL は PASS で途切れ、**NOT_EVALUATED_COACH_ONLY の本でも途切れる**（FAIL→COACH_ONLY→FAIL は2回連続に
  しない）。action=END_SET で終わった本より前の FAIL は次の set に持ち越さない。`firstFailureAction`（EXTEND_REST）は連続 FAIL が
  ちょうど1回目のときだけ。startQuality=POOR の連続は GOOD でも未入力でも途切れる。SP_TE の「速すぎ」
  （`timeS < 目標下端 − tolerance`）は評価できない本で途切れ、連続しても action は CONTINUE のまま reason
  `TEMPO_FASTER_THAN_TARGET_REPEATED`（WARN 相当）だけを出す。
- **action の優先順位。** STOP_SAFETY > END_SESSION_QUALITY > END_SET > EXTEND_REST > COACH_REVIEW > CONTINUE（順位表は1か所）。
  reason は全 trigger 分を残す。
- **EXTEND_REST の休息。** 延長量の式（+30秒・割合）を作らない。`nextRepRestS = { min: 計画の repRestS.value, max:
  repRestS.coachEditable.max }`（最低でも現行の休息を確保し、延長量はコーチが決める）。計画値 ≥ coachEditable.max で延長の
  余地が無ければ EXTEND_REST を返さず COACH_REVIEW（REST_EXTENSION_UNAVAILABLE）。EXTEND_REST 以外では `nextRepRestS=null`。
  同じ (setIndex, repIndex) の再判定は拒否（priorLogs は昇順・重複なし、観測は最後のログより後）するため、同じ本で EXTEND_REST
  が二重に出ない。`restTakenS` はログに残すだけで判定に使わない。
- **予定数への到達。** 完了本数（ログ件数 + 今回）≥ `sets × repsPerSet` で END_SESSION_QUALITY。reason は
  `PLANNED_REPS_COMPLETE`（EA は `ATTEMPTS_COMPLETE`）とし、品質低下による終了と区別する。
- **RepLogEntry（正式化）。** `stopPolicyId, setIndex, repIndex, timeS, timing, effectiveTiming, toleranceS, referenceTimeS,
  referenceSource, quality, fasterThanTargetLower, startQuality, measuredVelocityDecrementPercent, action, safetyOutcome,
  restTakenS, highSpeedExposureM, reasons`。痛み・部位・red flag・athleteReport の生値・自由記述・RuleSet object は保存しない。
  reason（StopReason）は永続化・日本語レンダリング可能な enum で、athlete 由来の中止は `SAFETY_STOP_ATHLETE` の1コードに
  まとめる（痛み・red flag・中止要請を区別して保存しない）。
- **実測露出。** 観測の `actualHighSpeedExposureM` は `source: "MEASURED"` だけを受け付ける。無ければ計画の項目合計
  （全本同一の積算）を `sets × repsPerSet` で割った1本分を `source: "PLANNED"` でコピー（null bound は null）。累積は完了した本数分
  だけを R6 の `sumIntervals`（null 伝播・弱い source / confidence を採る）で合計し、未来の予定本数を足さない。
- **[R8 deviation] セッション全体の曝露上限。** §10.4 step 6 の「実測露出が集計上限超過」は、1項目の処方 snapshot から R6 の
  セッション単位の予算を再構成できないため **評価しない**（`exposureLimitEvaluation: "NOT_EVALUATED"`。「上限内」と楽観しない）。
  planned exposure の上端や flyVolume の上限を安全上限と読み替えない。R9 / R11 でセッション単位の snapshot を接続する。

---

## 11. Session Aggregation

### 11.1 目的
監査 C-1（80km 無警告）・H-5（上限が種目単位）を再発させない。**MenuItem 1件で判定を終えない。** 項目の追加・更新・並べ替え・削除のたびに、メニュー全体を再評価する。

```ts
export type SessionAggregate = {
  totalRunningDistanceM: QuantityInterval<"m">;
  plannedHighSpeedExposureM: QuantityInterval<"m">;
  actualHighSpeedExposureM: QuantityInterval<"m"> | null;   // 練習記録の評価時のみ
  nearMaxSprintVolumeM: QuantityInterval<"m">;
  longSprintVolumeM: QuantityInterval<"m">;
  tempoVolumeM: QuantityInterval<"m">;
  strideVolumeM: QuantityInterval<"m">;
  plyometricContacts: QuantityInterval<"contacts">;
  strengthLoad: null;                                        // v2 では未定義（OPEN-16）
  raceExposure: { count: number; distanceM: QuantityInterval<"m"> };
  relayExposure: { count: number; legDistanceM: QuantityInterval<"m"> };
  highIntensityBudgetUse: { recommended: number; coachEditable: number };  // §11.4
  highIntensityMethods: RunningTrainingMethod[];
  completeness: "COMPLETE" | "PARTIAL";
  findings: Finding[];
};

export function evaluateSessionAggregation(items: AggregationItem[], ctx: AggregationContext): SessionAggregate;
// AggregationItem = v2 項目（prescriptionJson）| legacy 項目（MenuItem 列 + Exercise.category）
```

### 11.2 指標の定義 [ENGINE-POLICY]

| 指標 | 定義 |
| --- | --- |
| totalRunningDistanceM | 全走行距離（build-up・分割走の全区間を含む。deceleration は含めない） |
| nearMaxSprintVolumeM | 最大努力で走る距離。ACC・RS: 距離×本数／MV・AS: (build-up + fly)×本数／SES・LONG: 表示距離×本数／EA FULL: 助走距離×試技数 |
| longSprintVolumeM | LONG の総距離 |
| tempoVolumeM | TE + TI の総距離 |
| strideVolumeM | STRIDE の総距離 |
| plyometricContacts | legacy の JUMP 種目: 下限 = sets×(reps ?? 1)、上限 = sets×reps（reps が null なら上限 null）。source=ESTIMATED |
| 高速の定義 | 「現在の Vmax の95%以上」を**操作上の境界**として使う（科学的閾値ではない。ChatGPT DR） |

**高速曝露の区間計算**（`highSpeedExposureModel`）:

```
推定加速距離 A = [A_lo, A_hi]   // source=ESTIMATED, confidence=LOW
  DEVELOPMENTAL: [20, 30] m   ADVANCED: [40, 60] m

NONE                          → lower = upper = 0（source=RULE_DEFINITION）
FLY_ZONE                      → lower = fly × n
                                upper = (fly + max(0, buildUp − A_lo)) × n
DISTANCE_MINUS_ACCEL_INTERVAL → lower = max(0, d − A_hi) × n
                                upper = max(0, d − A_lo) × n
WHOLE_REP                     → lower = max(0, d − A_hi) × n
                                upper = d × n
RACE（大会記録）              → DISTANCE_MINUS_ACCEL_INTERVAL と同じ
RELAY（助走付き区間）         → lower = max(0, leg − 20) × n, upper = leg × n
```

- A の値: 若年・初心者は 20–30m 付近で最高速度近くに達し、上級者はより長く加速する、という方向は [SOURCE-BACKED]（Gemini/Perplexity/ChatGPT DR・Fable H-4）。**区間の数値は [ENGINE-POLICY]**。`distance − A` を真値として扱わず、常に区間で持つ。
- 旧来の legacy 走種目（Exercise の SPRINT 等、v2 ではない項目）: `sets/reps` の意味が曖昧なため、総走行距離を **下限 = 距離×sets、上限 = 距離×sets×(reps ?? 1)** の区間で持つ（監査 C-1 の曖昧さを区間で表す）。
- **[R4 errata]** R4 は項目単位の露出だけを出す（集計は R6）。推定加速距離 A の区間を TS 定数として持たない（RuleSet に未収録）ため:
  NONE → [0, 0]（RULE_DEFINITION）、FLY_ZONE → [fly×n, (fly + buildUp)×n]（ESTIMATED。build-up 全体を上端に含める安全側の上限）、
  DISTANCE_MINUS_ACCEL_INTERVAL / WHOLE_REP → [null, d×n]（ESTIMATED。A を要する下端は null で 0 にしない）。
  nearMaxSprintVolumeM は上表どおり（EA SHORT と TE / TI / STRIDE は [0, 0] RULE_DEFINITION、EA FULL は助走距離の入力が無ければ null）。
  SES の表示距離は template の displayDistanceM（RULE_DEFINITION）、LONG INCOMPLETE は計画した区間の合計だけ。

### 11.3 null / UNKNOWN の伝播規則 [ENGINE-POLICY]
- 1項目でも bound が null → 合計のその bound は null、`completeness = "PARTIAL"`、Finding `AGG_INCOMPLETE_DATA`（INFO）。
- 上限との比較は `upper` を使う。`upper` が null なら `lower` で比較し、超えていなければ Finding `AGG_NOT_DETERMINABLE`（WARN）。**null を 0 にしない。**
- `actualHighSpeedExposureM` が null の SessionItem は planned 区間を `source: "PLANNED"` で使う（§10.5）。

### 11.4 判定規則（rs-2026.09.0）

**[R6 pre-commit correction]** 「同一 Method の合計 > tier の recommended.max」という単一絶対上限の設計は、
同一 Method 内でも template ごとに Envelope 上限が異なる場合（例: TEMPO_INTENSIVE の TI_VITTORI_SE と
TI_COACH_DEFINED）に一意の判定ができないため廃止した。代わりに **per-item normalized Method budget** を使う:

```
item usage      = item の contribution ÷ その item が実際に使っている template/tier の Envelope 上限
methodBudgetUse = Σ item usage（同一 Method 内の全 item）
```

`methodBudgetUse > 1.0` で「1セッション分の Envelope budget を超えた」と判定する。**1.0 は新しい科学的閾値ではなく、
「各 item 自身の Envelope 上限を 100% とする」という normalized budget の定義値**（ENGINE-POLICY。RuleSet の
versioned な値ではない）。量に掛ける係数ではなく判定専用の無次元比率であり、処方値は一切変更しない。
DEV の ACC を3項目並べる従来ケース（全 item が同じ cap）は `Σ(120/cap) = (120+120+120)/cap` と数学的に一致し、
旧方式と同じ結果になる（監査 H-5 対策は維持）。

| code | 条件 | severity | 判断 |
| --- | --- | --- | --- |
| AGG_METHOD_BUDGET_OVER_RECOMMENDED | 同一 Method の normalized budget（Σ item usage、各 item の recommended.max 基準）> 1.0 | WARN | [ENGINE-POLICY]（「加速3項目で上限3倍」を塞ぐ） |
| AGG_METHOD_BUDGET_OVER_EDITABLE | 同じ budget を各 item の coachEditable.max 基準で計算して > 1.0 | REQUIRE_COACH_REVIEW + BLOCK_AUTOGEN | [ENGINE-POLICY] |
| AGG_METHOD_CAP_NOT_DETERMINABLE | ある item の template/tier に metric の Envelope セルが無い等、**真に分母を取得できない** | WARN | [ENGINE-POLICY]（同一 Method 内で template ごとに上限が違うだけでは出さない） |
| AGG_HIGH_INTENSITY_BUDGET | **高強度予算**: loadClass が HIGH_* の **item ごとに** `contribution ÷ その item の上限（recommended.max 基準）` を求めた総和 > RuleSet の閾値 | WARN | [ENGINE-POLICY・provisional] OPEN-06 |
| AGG_HIGH_INTENSITY_BUDGET_EDITABLE | 同じ総和を各 item の coachEditable.max 基準で計算して > RuleSet の閾値 | REQUIRE_COACH_REVIEW + BLOCK_AUTOGEN | [ENGINE-POLICY] |
| AGG_TEMPO_OVER | tempoVolumeM > TE の sessionVolumeM.recommended.max | WARN | [ENGINE-POLICY] |
| AGG_STRIDE_OVER | strideVolumeM > STRIDE の coachEditable.max | WARN | [ENGINE-POLICY]（STRIDE に TE の量を使わない） |
| AGG_TOTAL_RUNNING_CONFIRM / BLOCK | §8.5 の Session 行 | REQUIRE_CONFIRMATION / BLOCK | [ENGINE-POLICY] |
| AGG_COMPETITION_DAY_EXTRA | 大会当日のセッションに race 以外の HIGH_* 項目 | REQUIRE_COACH_REVIEW | [ENGINE-POLICY] |
| AGG_REST_INFEASIBLE | Σ(本数×rest) + 走行時間 > availableMinutes | WARN | [ENGINE-POLICY] |

- **Method budget（1.0）と高強度予算（RuleSet の閾値）は別物。** Method budget は「同じ Method を複数項目に
  分割して上限を実質倍増すること」を防ぐ定義上の 100% 判定、高強度予算は「異なる HIGH_* Method を同日に
  積み上げること」を検出する ENGINE-POLICY・provisional なしきい値（引き続き RuleSet 側の値を使う）。
  計算 primitive（item usage の合計）は共通でよいが、Finding は別にする。
- 高強度予算は**量への乗数ではなく、既存の Envelope 上限を按分する判定**。例: 同日に ACC 150m（上限 300m → 0.5）と MV fly 90m（上限 150m → 0.6）→ 1.1 → WARN（§20 T-AGG-03）。TI のように heterogeneous な template を含む Method が混在しても、item ごとに上限を引くため一意に計算できる。
- recommended が null の item（ASSISTED・TI_COACH_DEFINED）は coachEditable.max を fallback denominator にする。
  これは「recommended があると偽装する」ことではなく、recommended-level の按分判定を評価するための代替分母。
- plyometricContacts と strengthLoad には rs-2026.09.0 で上限を置かない（legacy の接地上限 120回は出典なし）。表示と週次文脈にのみ使う。[OPEN-16]

### 11.6 [R6 representation errata]（R6 実装で確定した表現）

§11.1〜§11.5 の意味は変えず、実装上の表現だけを次のとおり確定する
（`src/domain/running/aggregation/` の型と `RuleSet.aggregationRules` が正）。

1. **`AggregationItem` は2種類だけ**（strict な判別共用体）:
   `{ kind: "RUNNING_V2", prescription }`（完成した処方のスナップショット。生の PlanRequest は渡さない）と
   `{ kind: "LEGACY", item }`（legacy 項目の最小要約 = `category` / `sets` / `reps` / `distanceMeters` /
   `durationSeconds` / `restSeconds` のみ。巨大な Exercise 行を domain へ渡さない。NaN / Infinity / 非正値は拒否）。

2. **`AggregationContext`** = `{ ruleSet, tier, availableMinutes, competitionDay, mode }`。
   `competitionDay` は R7 まで `"NOT_EVALUATED"` 固定で、**false 扱いにもしない**（大会日を推測しない。
   `AGG_COMPETITION_DAY_EXTRA` は R6 では発火させない）。RuleSet は解決済みオブジェクトで受け取り、
   version 文字列を request 側から指定させない（§18.1）。

3. **判定データは `RuleSet.aggregationRules`**（版管理・contentHash の対象）:
   `ACCEL_INTERVAL`（tier ごとの推定加速距離 A の区間）、`RELAY_ALLOWANCE`、`METHOD_AGGREGATION`
   （Method ごとの `volumeMetric` / `nearMaxModel` / `volumeCategory`）、`HIGH_INTENSITY_BUDGET`
   （しきい値と recommended 欠損時の分母）、`SESSION_VOLUME_LIMIT`（tempo / stride がどの Envelope 上限を見るか）、
   `LEGACY_CATEGORY`（legacy の category が走行距離か接地数か）。
   **Method ごとの量の上限は Envelope（`recommended.max` / `coachEditable.max`）が single source of truth**であり、
   `aggregationRules` に数値を再入力しない。ID・表示名・`conditionNote` の解析で分岐しない（§8.2 と同じ方針）。

4. **[R6 pre-commit correction] Method に1個の絶対上限があるという設計を廃止し、per-item normalized budget に
   一般化した。** 同じ Method × tier × metric でも template によって Envelope 上限が異なりうる
   （rs-2026.09.0 の実データ監査で判明: `TEMPO_INTENSIVE × ADVANCED × sessionVolumeM` は `TI_VITTORI_SE`
   （recommended.max=1200 / coachEditable.max=2000）と `TI_COACH_DEFINED`（recommended=null /
   coachEditable.max=1600）で異なる）。`max` / `min` / 平均を勝手に採る・どちらかの template を決め打つ・
   新しい科学数値を作る、のいずれもしない。代わりに **item ごとに実際に使っている template/tier/recoveryStructure
   の Envelope セルから上限を引き**（`resolveItemCap`）、`item usage = contribution ÷ その item の上限` を
   同一 Method 内で合計する（`methodBudgetUse = Σ usage`）。DEV ACC 3項目のような homogeneous なケースは
   旧方式と数学的に一致する（§11.4 冒頭参照）。
   `AGG_METHOD_CAP_NOT_DETERMINABLE`（WARN）を出すのは、**真に分母を取得できない item がある場合だけ**
   （aggregation metric に対応する Envelope セルが無い、同一 template × tier × recoveryStructure の行が複数あって
   上限が食い違う malformed RuleSet 等）。template ごとに上限が異なること自体はこの Finding の理由にしない。
   判明した item だけの usage 合計が既に閾値を超えていれば、不明な item を足しても増えることはあっても
   減らない（非負の比率の総和）ので `OVER` と断定してよい。超えていなければ、不明な item がある間は
   「範囲内」と断定しない（`AGG_METHOD_CAP_NOT_DETERMINABLE` を維持するだけで `OVER` は出さない）。
   高強度予算（`AGG_HIGH_INTENSITY_BUDGET*`）も同じ primitive（item ごとの usage の合計）に統一し、
   heterogeneous な template を持つ Method が混在しても一意に計算できるようにした。
   completeness の監査は「同じ Method/tier の cap が全 template で同一」ではなく、
   「各 Method × tier × 実在する template（× recoveryStructure）について、`METHOD_AGGREGATION.metric` に
   対応する Envelope セルから少なくとも `coachEditable.max` を取得できる」ことを検証する
   （`recommended` は null 可。null の場合は fallback policy を使う）。

5. **`QuantityInterval` の source / confidence の合成**（ENGINE-POLICY）:
   `RULE_DEFINITION` の `[0,0]`（定義上の既知 0）は合計の確からしさを下げないので無視し、残りのうち
   **最も弱い source**（`MEASURED` < `PLANNED` < `COACH_ENTERED` < `ESTIMATED` < `UNKNOWN`）と
   **最も低い confidence** を採る。すべてが既知 0 のときだけ `RULE_DEFINITION` のまま。
   `ESTIMATED` を含む合計を `MEASURED` にしない。unknown な bound は null のまま伝播する。

6. **completeness**: 集計対象 metric のいずれかの bound が null なら `PARTIAL` + `AGG_INCOMPLETE_DATA`（INFO）。
   「定義上その metric へ 0 しか寄与しない」項目（STRIDE の高速曝露など）は unknown ではないので `COMPLETE` のまま。

7. **上限比較**: `upper` があれば `upper`、無ければ `lower` で比較し、`lower` も超えていなければ
   **安全とは断定せず** `AGG_NOT_DETERMINABLE`（WARN）。null を 0 にしない。

8. **`AGG_METHOD_BUDGET_OVER_EDITABLE` / `AGG_HIGH_INTENSITY_BUDGET_EDITABLE`** は
   「REQUIRE_COACH_REVIEW + BLOCK_AUTOGEN」の2つの意味を持つが、`Finding.severity` は1つしか持てないため、
   **同じ code の Finding を2件**（severity 違い）出して両方の意味を保つ。どちらか一方を捨てない。

9. **rest の数え方**（同じ休息を二重計上しない）: 本間 = `sets × max(0, repsPerSet − 1)` 回、
   セット間 = `max(0, sets − 1)` 回、分割走の区間休息 = `(segments − 1) × totalReps` 回。
   走行時間は確実に計算できるもの（DURATION rep・コーチ入力の TARGET_SPLIT の下限合計）だけを足し、
   不明な走行時間を推測しない。収まって見えても不明が残る場合は「OK」と断定せず Finding を出さないだけにする。

10. **`actualHighSpeedExposureM`** は R6（計画時）では常に `null`。「未実測だから 0」にはしない（実測は R8/R9）。
    `strengthLoad` も `null` のまま（OPEN-16。筋トン数を発明しない）。

11. **[R6 provisional legacy policy] legacy の category semantics**: `SPRINT` / `ENDURANCE` は走行距離、
    `JUMP` は接地数、`WARM_UP` / `MOBILITY` / `COOL_DOWN` / `THROW` / `STRENGTH` / `CORE` は定義上 0。
    `HURDLE` / `DRILL` / `OTHER` は**走かどうかを既存 category semantics だけでは断定できない**ため `UNKNOWN` とし、
    距離が入っている場合だけ unknown を伝播する（勝手に走／走でないを決めない・0 と推定する方が危険）。
    これは R6 初版の暫定方針であり、将来 category の意味がより正確に定義された時点で見直してよい。[OPEN]
    legacy には強度の情報が無いため、走項目の高速曝露・nearMax は **0 と決めつけず unknown** にする。
    `JUMP` は `plyometricContacts` だけを集計し、走行距離は推測しない（接地上限も作らない）。

12. **[R6 integration policy] `REQUIRE_CONFIRMATION`**: 確認済みを表現する contract（確認 UI）がまだ無いため、
    最終出力（item / session）に `REQUIRE_CONFIRMATION` が残る場合は **全 actor で `PlanResult.BLOCKED`** として返す。
    `CoachOverride` では突破できない。確認 contract を追加した時点でこの暫定方針を解除できる。
    **[R10-B4A] 確認 contract を追加し、次のとおり置き換えた**: `PlanRequest.confirmedFindingCodes: string[]`（既定 `[]`、
    COACH 以外の actor は持てない）に、出力 plausibility（item / session）の `REQUIRE_CONFIRMATION` の code が**すべて**
    含まれるときだけ OK を返す（code 単位。override では突破できないのは従来どおり）。足りなければ BLOCKED で、
    そのときだけ `PlanResult.BLOCKED.confirmationRequired = { requiredFindingCodes }`（現在の結果の REQUIRE_CONFIRMATION の
    code 全体）を付ける。確認済みでも Finding は消さない（item は `prescription.findings`、session は `sessionFindings`）。
    `BLOCK` は当然すべての actor で BLOCKED。session の `BLOCK_AUTOGEN` は AI / SYSTEM のみ BLOCKED とし、
    COACH は `REQUIRE_COACH_REVIEW` を保ったまま手動で継続できる（hard BLOCK と区別する）。
    **[R11-B1] セッション作成時**（B2 の aggregation 由来の `REQUIRE_CONFIRMATION`）も同じ「code 単位の明示確認」で
    作成できるようにした（2段階確認 + confirmation challenge。詳細は §22 の R11 行）。`BLOCK` は確認では解除できない。

13. **Finding の scope**: 項目の出力 plausibility は `ITEM`（`prescription.findings`）、
    §11 の集計由来は `SESSION`（`PlanResult.sessionFindings`）。混ぜない。

14. **`PlausibilityRule.outputTarget`**（R6 で追加した機械可読メタデータ）:
    `PRESCRIPTION_FIELD` / `REP_DISTANCE` / `ITEM_TOTAL_DISTANCE` / `SESSION_TOTAL_DISTANCE` /
    `TOTAL_REPS_VS_RECOMMENDED`。**閾値そのものは R2 の値から変更していない。**
    入力 plausibility の canonical 実装は `plausibility/input.ts` に一本化し、
    `context/plausibility.ts` は再 export（互換ラッパ）にする。

15. **[R6 formal spec correction] §20 T-PLA-01 の入力 template を修正する。** 旧記述は「TE で
    distance=5000 × reps=8 × sets=2」だったが、rs-2026.09.0 の TE template（`TE_100`/`TE_200`/`TE_300`）は
    `fixedDistanceField=repDistanceM` で距離が template 固定であり、コーチが distance=5000 を入力できない
    （現行 Template contract では表現不能）。80km 事故を再現する正式ケースは
    **`TI_COACH_DEFINED`（TEMPO_INTENSIVE。distance がコーチ入力）で distance=5000 × reps=8 × sets=2**
    に修正する。§8.5 の「1本の距離（TE/TI）」行は TE と TI の両方に適用されるため、事故の趣旨（監査 C-1）は
    変わらない。項目 80,000m → 項目 BLOCK（>10000m）+ Session BLOCK（>30000m）、override 不可。
    legacy の「ペース走 5000m」ケース（監査 C-1 のもう一方）はテスト用の再現であり変更しない。

### 11.5 呼び出し箇所
- MenuItem の add / update / move / delete の各 Server Action（R10）。
- セッション作成の application layer（R10）。`createSessionFromMenu()` を呼ぶ**前**に、保存済み MenuItem の
  `ruleSetVersion` + `ruleSetContentHash` に一致する RuleSet で評価し、結果を `SessionPlanningEvaluationInput` として
  repository に渡す。repository はそれを `TrainingSession.planningSnapshotJson` に保存するだけで、自分では評価しない（§17.1 不変条件2）。
- **[R9 clarification]** 評価結果が渡されない経路（legacy のセッション作成・repository の直接呼び出し）では
  `aggregation` / `weeklyContext` を `NOT_EVALUATED`（`PLANNING_EVALUATION_NOT_SUPPLIED`）として保存する。
  これは R9→R10 の phase boundary であり FAIL ではない。

---

## 12. Weekly Context

### 12.1 LoadEvent（走以外も含む）

```ts
export type LoadEvent = {
  at: IsoDateTime;
  category: LoadCategory;               // RUNNING_HIGH_INTENSITY / RACE / RELAY / PLYOMETRIC / STRENGTH / JUMPS / HURDLES / RUNNING_LOW_INTENSITY / OTHER
  method: RunningTrainingMethod | null;
  intensityTag: "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";
  magnitude: { distanceM?: QuantityInterval<"m">; highSpeedExposureM?: QuantityInterval<"m">; contacts?: QuantityInterval<"contacts">; attempts?: number };
  source: "SESSION_RECORD" | "COMPETITION_RECORD" | "COACH_ENTRY";
  completion: "DONE" | "PARTIAL" | "PLANNED_NOT_CONFIRMED";
};
```

### 12.2 履歴の導出（repository 層で LoadEvent に変換）[ENGINE-POLICY]

| 元データ | category | intensityTag |
| --- | --- | --- |
| v2 SessionItem（done / 実施ログあり） | MethodMeta.weeklyLoadCategory（[R9] = `SessionItem.loadCategory`。作成時に処方の `loadSnapshot.weeklyLoadCategory` をコピー） | HIGH_* → HIGH、MODERATE → MODERATE、LOW → LOW（[R9] `plannedPrescriptionJson.loadSnapshot.loadClass` から。category から推定しない） |
| legacy SessionItem（Exercise.category=SPRINT/HURDLE/JUMP/STRENGTH） | RUNNING_HIGH_INTENSITY / HURDLES / PLYOMETRIC / STRENGTH | **UNKNOWN**（強度が記録されていない） |
| Exercise 削除済みの legacy 項目 | `SessionItem.loadCategory` スナップショット、無ければ OTHER | UNKNOWN |
| 大会セッション（`sessionKind="COMPETITION"`） | RACE / RELAY（[R11-B6] 新規は `planningSnapshotJson.competitionLoadCategories` をcategoryごとに投影。旧 `competitionLoadCategory` も読取可。無ければ RACE = generic fallback） | HIGH |
| コーチ手入力（学校体育・他クラブ等） | 選択式 | 選択式 |
| 過去日付で `status=PLANNED` のまま | 元の category | 元の tag、completion=PLANNED_NOT_CONFIRMED（**実施したものとして扱う**） |

- **[R9 errata] v2 の旧 snapshot / 壊れた snapshot。** `plannedPrescriptionJson` が null・壊れている・`loadSnapshot` の無い
  旧 snapshot のときは、intensityTag = UNKNOWN、category = `SessionItem.loadCategory ?? OTHER`（安全情報を捏造しない）。
- **[R9/R11-B6 errata] 大会の旧singular種別。** `competitionLoadCategory: "RACE" | "RELAY"` は旧データのread compatibility専用であり、
  新規writerは設定しない。新規大会実績writerのauthorityはcanonicalな`competitionLoadCategories`だけである。旧singularで明示された
  RELAYはRACE fallbackを上書きする。種別が無い（既存・未指定）ときの RACE は **generic competition running load
  fallback** であり、「実際に個人種目だった」と推定した意味ではない。RACE / RELAY は週次 safety 上どちらも HIGH で同じ 48h guard の
  対象なので、UNKNOWN→OTHER に落として guard を逃すことを避ける。種別不明でも intensityTag = HIGH。距離・露出は推測せず
  unknown 区間（`lower = upper = null`、0 にしない。リレー区間距離もレース距離も作らない）。
- **[R11-B6] mixed大会日の投影。** 新規大会実績は `competitionLoadCategories` を `['RACE']` / `['RELAY']` /
  `['RACE','RELAY']` のcanonical集合として保存する。mixedは同じTrainingSessionからRACE→RELAYの2 LoadEventを生成するが、両eventの
  `sessionKey`は同じSession idなので`highSessions7d`は1件。Competition calendar row自体はLoadEventを生成しない。

### 12.3 時間窓（Method 別の固定時間を持たない）

- [SOURCE-BACKED] 高強度セッションは通常48h程度離す実践（Haugen 2019）。**Method 別に 48h/72h を分けない**（Fable H-6：出典なし）。
- [SOURCE-BACKED] 高強度走・跳躍・スクワット・負荷走後の疲労が 48–72h 残る報告（Thomas 2018 は crossover・n=10 成人男性、resisted 2023）→ CHECK_ONLY。
- [ENGINE-POLICY] 参照は**最低72h**。48h = 通常のスケジューリング guardrail、72h = readiness 確認窓。

| code | 条件（計画項目が loadClass HIGH_* のとき） | 結果 |
| --- | --- | --- |
| WEEKLY_HIGH_WITHIN_48H | 48h 以内に HIGH の RUNNING_HIGH_INTENSITY / RACE / RELAY | BLOCK_AUTOGEN + REQUIRE_COACH_REVIEW |
| WEEKLY_NONRUN_HIGH_WITHIN_48H | 48h 以内に HIGH の PLYOMETRIC / STRENGTH / JUMPS / HURDLES | BLOCK_AUTOGEN + REQUIRE_COACH_REVIEW |
| WEEKLY_UNKNOWN_WITHIN_48H | 48h 以内に UNKNOWN の上記カテゴリ | readiness 必須。readiness が無ければ USE_LOWER_BOUND |
| READINESS_CHECK_REQUIRED | 48–72h に HIGH イベント | readiness 必須。無ければ USE_LOWER_BOUND |
| HISTORY_UNKNOWN | 72h 履歴が null、またはコーチが「記録外の活動なし」を未確認 | prescriptionConfidence=LOW、HIGH_METABOLIC は REQUIRE_COACH_REVIEW |
| （対象外） | TEMPO_EXTENSIVE / STRIDE | 48h ルールでロックしない |

- `plannedDate` が null のメニュー（日付の無いテンプレート）では週次評価をせず `WEEKLY_NOT_EVALUATED`（INFO）。練習作成時（日付確定時）に、R10 のセッション作成 application layer が評価して repository に渡す（§11.5。repository は評価しない）。

### 12.4 7日間ガード [ENGINE-POLICY]（7日という日数自体は科学的最適値ではない）

| code | 条件 | severity | 判断 |
| --- | --- | --- | --- |
| WEEKLY_HIGH_SESSIONS | 直近7日の HIGH セッション（大会含む）が 3 以上 | WARN | 「高強度は週2回程度」の実践（Claude/ChatGPT DR）を方向として参照、閾値は EP |
| （institutional weekly guidance） | 日本の学校部活動・適用対象の認定地域クラブで trusted context が明示された場合のみ別途 review 対象 | CHECK_ONLY | Sports Agency 令和7年12月 guidance。現行 MVP の自動 runtime rule ではない |
| （未実装） | 高速曝露の週次急増 | — | OPEN-17（閾値の出典なし） |

### 12.5 出力

```ts
export type WeeklyContextResult = {
  evaluatedAt: IsoDateTime | null;          // null = 未評価
  coverage72h: "COMPLETE" | "PARTIAL" | "NONE";
  events48h: LoadEvent[];
  events72h: LoadEvent[];
  highSessions7d: number;
  readinessRequired: boolean;
  autogenBlockedMethods: RunningTrainingMethod[];
  findings: Finding[];
};
```

### 12.6 [R7 representation errata]（R7 実装で確定した表現）

- **`menuContext.plannedAt: IsoDateTime | null` を追加する。** 48h/72h の厳密な時間窓は「計画された正確な時刻」が無いと評価できない。
  `plannedDate`（暦日）だけでも §14（大会近接・taper・新規刺激）は評価できるが、§12 の48h/72h 窓だけは
  `plannedAt` が無いと `NOT_EVALUATED`（中立。ACTIVE と推測しない）になる。制約: `plannedDate === null` ⇒ `plannedAt` は必ず
  `null`。`plannedDate !== null && plannedAt !== null` のときは `plannedAt` の暦日が `plannedDate` と一致しなければならない。
  `plannedDate !== null && plannedAt === null` は明示的に許可する（大会の「何日前」は評価できるが週次窓だけ NOT_EVALUATED）。
  OS 時刻や 00:00/12:00/23:59 を補って `plannedAt` を捏造することは一切しない。
- **`WeeklyContextResult` に `weeklyPositionCap: RangePosition | null` を追加する。** §12.4 の
  「readiness が無いときの USE_LOWER_BOUND 相当」は `ReadinessDecision` を捏造せず、この weekly 由来の位置上限として表現する
  （§9.3 の他の位置上限候補と同じ `lowestPosition()` で合成する）。
- **`LoadEvent` を完成させる。** `templateId`（v2 のイベントは Method に対応する厳密な template id を持つ。legacy/大会/外部記録は
  `null` を許可）と `sessionKey: string`（本数ではなく「セッション数」で数えるための識別子。§12.4 の7日ガードに使う）を追加する。
- **`DailyActivitySummary` / `WeeklyHistoryInput` を新設し、`history: LoadEvent[] | null` を置き換える。**
  `{ date, hadActivity, trainingMinutes }`（`hadActivity=false` のときだけ `trainingMinutes=0` を許可。「記録が無い」を
  「休養日」と推測しない）と `{ events, coverage72h, coverage7d, coverage28d, dailyActivity7d }`
  （`coverage* : "COMPLETE" | "PARTIAL" | "NONE"`）。`COMPLETE` = 「記録に無いイベントは無かったと確認できている」、
  `PARTIAL` = 「記録はあるが完全性は確認できていない」、`NONE` = 「履歴が渡されていない」。`history = null` は
  `coverage72h = NONE` 相当として扱うが、呼び出し側が渡した `WeeklyHistoryInput` オブジェクトが実際には不完全なのに
  `COMPLETE` を自称することまでは防げないため、`coverage7d = COMPLETE` を主張する入力は `dailyActivity7d` の7日分の暦日が
  重複なく期待した窓と厳密に一致するかを検証し、一致しなければ `PARTIAL` へ格下げする（`WEEKLY_COVERAGE7D_INCONSISTENT`）。
  - **[R7 pre-commit correction] 対象7 calendar dates の契約を明示する。** `coverage7d = COMPLETE` が要求する7日は
    **`plannedDate` を含み、そこから遡って6日（`plannedDate - 6日` 〜 `plannedDate`）の計7日**。`plannedDate` 自身が
    欠けている窓（例: `plannedDate-7`〜`plannedDate-1`）は COMPLETE と認めない。`DailyActivitySummary.date` は
    文字列の暦日境界としてそのまま使い、`evaluatedAt`（`plannedAt`）の時刻・タイムゾーンから変換しない
    （`calendarDateOf` と同じ「先頭10文字」規約）。「その日の記録が無い」ことを「休養日」とは絶対に推測しない
    （`DailyActivitySummary` 自体が該当日に無ければ、その日の活動有無は不明のまま）。
- **U15 の年齢帯だけでは institutional weekly guidance を評価しない。** 日本の学校部活動等の trusted context が存在しない現行 MVP では、休養日数・週間時間を自動判定しない。将来 context を明示的に入力できる機能を追加する場合も、UNKNOWN を適用可能として扱わない。
- **48h/72h の窓は Method 別の固定時間を持たない。** 判定は「経過時間」と MethodMeta.loadClass（HIGH_NEURAL /
  HIGH_METABOLIC）だけで行い、ACC=48h・SES=72h のような Method 別定数は実装しない（`weekly/` 配下の grep テストで
  数値の複製が無いことを検証する）。TEMPO_EXTENSIVE / STRIDE は48h ロックの対象外（他の週次表示・7日ガードの対象からは
  除外しない）。

---

## 13. Readiness

### 13.1 入力

```ts
export type BodyRegion = "HEEL" | "KNEE" | "HIP_PELVIS" | "HAMSTRING" | "CALF_ACHILLES" | "SHIN" | "FOOT_ANKLE" | "LOWER_BACK" | "GROIN" | "OTHER";
export type RedFlag =
  | "PAIN_AT_REST_OR_NIGHT" | "SWELLING" | "LIMPING" | "PAIN_WORSENING_DURING_SESSION"
  | "SUDDEN_SHARP_PAIN" | "NUMBNESS_TINGLING" | "DIZZINESS_OR_BREATHING_DIFFICULTY" | "PAIN_PERSISTING_OVER_DAYS";

export type PainReport = { status: "NONE_REPORTED" | "PRESENT" | "NOT_ASKED"; regions: BodyRegion[]; redFlags: RedFlag[] };

export type ReadinessReport = {
  pain: PainReport;
  soreness: 1 | 2 | 3 | 4 | 5 | null;
  fatigue: 1 | 2 | 3 | 4 | 5 | null;
  sleepQuality: 1 | 2 | 3 | 4 | 5 | null;
  performanceStatus: "NORMAL" | "DOWN" | "UNKNOWN";   // ウォームアップ中のタイム・感覚
  reporter: "ATHLETE" | "COACH" | "PARENT";
  reportedAt: IsoDateTime;
};
```

- 部位は選択式のみ。**自由記述欄を作らない**。[ENGINE-POLICY]（Fable M-12）
- 尺度（1–5）は [ENGINE-POLICY]（ChatGPT DR の提案形式）。主観的 wellness を集める意義は [SOURCE-BACKED]（systematic review）。

### 13.2 Pain gate（hard gate・計画時と実施時の両方）[ENGINE-SAFETY-POLICY]

これは診断ロジックではない。旧 `JSPO` の正確な一次資料 attribution は行わず、`EV_ENGINE_SAFETY_POLICY` として、誘発負荷の停止/変更、assessment、持続症状・red flag の医療評価を保守的に扱う。

| 条件 | 出力 | override |
| --- | --- | --- |
| redFlags に PAIN_AT_REST_OR_NIGHT / SWELLING / LIMPING / NUMBNESS_TINGLING / DIZZINESS_OR_BREATHING_DIFFICULTY / PAIN_PERSISTING_OVER_DAYS | `STOP`（当日の走処方なし。STRIDE も出さない）+ `MEDICAL_EVALUATION_RECOMMENDED` | 不可 |
| その他の redFlags（SUDDEN_SHARP_PAIN / PAIN_WORSENING_DURING_SESSION） | `STOP` + `COACH_REVIEW` | 不可 |
| status=PRESENT（red flag なし） | `CANCEL_HIGH_INTENSITY` + `REQUIRE_COACH_REVIEW` | 可（理由必須） |
| status=PRESENT、ageBand≠ADULT、部位 ∈ {HEEL, KNEE, HIP_PELVIS} | 上記 + 表示文「成長期では評価が必要な痛みの可能性があります。誘発する負荷を止める/変更し、続く場合は受診を検討してください」（診断ではない） | 可 |
| status=NOT_ASKED、ageBand≠ADULT、計画に HIGH_* あり | `PAIN_CHECK_REQUIRED`（REQUIRE_COACH_REVIEW）。確認されるまで HIGH_* を自動生成しない | — |
| status=NONE_REPORTED | gate 通過（**高強度の許可ではない**。§13.3 を続けて評価） | — |

### 13.3 Action 選択（数値係数に変換しない）[ENGINE-POLICY・provisional]

| 条件 | Action |
| --- | --- |
| performanceStatus = DOWN | SWAP_TO_LOWER_LOAD_METHOD + REQUIRE_COACH_REVIEW |
| soreness ≥ 4 | SWAP_TO_LOWER_LOAD_METHOD |
| 「soreness=3」「fatigue≥4」「sleepQuality≤2」のうち2つ以上 | SWAP_TO_LOWER_LOAD_METHOD |
| 上記のうち1つ | USE_LOWER_BOUND + INCREASE_REST |
| readiness 窓（§12.3）内で soreness/fatigue/sleep がすべて null | USE_LOWER_BOUND |
| それ以外 | NO_CHANGE |

- 優先順位: `CANCEL_HIGH_INTENSITY` > `SWAP_TO_LOWER_LOAD_METHOD` > `USE_LOWER_BOUND`・`INCREASE_REST`（併存可）> `NO_CHANGE`。`REQUIRE_COACH_REVIEW` は常に追加可能。
- **「fatigue 4 だから volume 73%」のような割合は一切作らない。**

### 13.4 SWAP 先 [ENGINE-POLICY]

| 元 | SWAP 先（eligibility を再評価） |
| --- | --- |
| ACCELERATION / MAX_VELOCITY / RESISTED / ASSISTED / EVENT_APPROACH | STRIDE（ST_RELAXED、LOWER_BOUND）または中止 |
| SPRINT_ENDURANCE_SHORT / LONG / TEMPO_INTENSIVE | TEMPO_EXTENSIVE（LOWER_BOUND）または STRIDE |
| TEMPO_EXTENSIVE | STRIDE |
| STRIDE | 変更なし |

### 13.5 未成年の健康情報（AI・保存）[ENGINE-POLICY]
- `PainReport` / `ReadinessReport` / `birthDate` / `sexForNorms` / `maturity` の詳細を **AI MenuPlanner に渡さない**。AI に渡すのは次の型だけ:

```ts
export type AiSafeSubjectContext = {
  tier: EnvelopeTier;
  ageBand: AgeBand;                      // 暦年齢帯のみ（生年月日は渡さない）
  allowedMethods: RunningTrainingMethod[];
  autogenBlockedMethods: RunningTrainingMethod[];
  highIntensityAllowedToday: boolean | "UNKNOWN";
  primaryEvent: string;
};
```

- 保存: 計画処方内では `readinessApplied`（enum 配列）と `safetyOutcome`（enum）を保持する。**[R11-B2 / Option B] 実施時の SessionItem は `readinessActionsJson` に下記 v1 item execution payload、別列 `safetyOutcome` に R5 outcome を保存する。** これは R5 Decision 全体の snapshot ではない。**部位・red flag・尺度値は保存しない**（その場の判定にだけ使う）。傷害履歴として残すかは [OPEN-15]。
- テスト: `AiSafeSubjectContext` を JSON 化した文字列に `pain` `region` `redFlag` `soreness` `fatigue` `sleep` `birth` `sex` `maturity` のキーが含まれないこと（§20 T-AI-06）。
- **[R8 errata]「部位・red flag・尺度値は保存しない」の意味の明確化。** 保存を禁じるのは **選手本人の health observation**
  — 報告された `BodyRegion`、選択された `RedFlag`、pain / soreness / fatigue / sleep の値、reporter / reportedAt、
  athleteReport / ReadinessReport の生値 — である。RuleSet から plan 時にコピーした **全選手共通の runtime safety policy
  定義**（`monitoringSnapshot.safetyPolicy` = RedFlag → safetyOutcome のグループ表。RedFlag の enum 名を含む）は health
  observation ではなく、snapshot の再現性（§17.1-5）のために `plannedPrescriptionJson` へ保存してよい。ただし policy snapshot へ
  **選手の選択値・部位・尺度・報告者・rule id を混入してはならない**（schema は `.strict()` で拒否し、テストで「選手・readiness
  入力に依存せず RuleSet の行と完全一致」を検証する）。
  - これに合わせ、R5 の「処方 JSON 全体に `pain` が1文字でもあってはならない」という文字列走査テストは、static policy 名
    （`PAIN_AT_REST_OR_NIGHT` 等）まで誤検出するため、**privacy を弱める変更ではなく「個人 health data」と「static runtime
    policy」を区別する scope correction** として2層に分けた: A. safetyPolicy を除いた処方全体の個人 health data 走査（R5 invariant
    を維持）、B. safetyPolicy 専用の検証（strict・RuleSet と完全一致・自由記述 / BodyRegion / reporter / 尺度 / 選択値 / rule id 無し）、
    C. safetyPolicy が選手・readiness 入力・action・safetyOutcome から独立であること。
  - RepLogEntry（§10.6）にも painNow / painRegion / RedFlag / athleteReport / BodyRegion / 症状の詳細を保存しない。

### 13.6 [R5 representation errata]（R5 実装で確定した表現）

§13.1〜§13.5 の意味は変えず、実装上の表現だけを次のとおり確定する（`src/domain/running/readiness/` の型と
`RuleSet.readinessRules` が正）。

1. **STOP と SafetyOutcome を分ける。** §13.2 の「`STOP` + `MEDICAL_EVALUATION_RECOMMENDED`」のような複合出力は
   単一 enum に潰さず、`stopPlanning: boolean` と `safetyOutcome: "NONE" | "COACH_REVIEW" |
   "MEDICAL_EVALUATION_RECOMMENDED"` の2つで表す（`SafetyOutcome` の `"STOP"` は使わない）。
   医療系 red flag → `stopPlanning=true` + `MEDICAL_EVALUATION_RECOMMENDED`、その他の red flag →
   `stopPlanning=true` + `COACH_REVIEW`、status=PRESENT（red flag なし）→ `stopPlanning=false` +
   `COACH_REVIEW` + `CANCEL_HIGH_INTENSITY` + `REQUIRE_COACH_REVIEW`、通常 → `stopPlanning=false` + `NONE`。

2. **ReadinessDecision（§13 の出力）**:

```ts
export type ReadinessDecision = {
  actions: ReadinessActionCode[];               // §13.3 の離散 action（優先順位順に正規化済み）
  triggers: { ruleId: string; actions: ReadinessActionCode[] }[];  // signal 単位の raw trigger（再正規化用・保存しない）
  stopPlanning: boolean;                        // §13.2 の STOP（override 不可）
  safetyOutcome: SafetyOutcome;
  highIntensityAllowedToday: boolean | "UNKNOWN";
  painCheckRequired: boolean;                   // §13.2 NOT_ASKED（override では解除できない）
  transientFindings: Finding[];                 // 表示用。処方には保存しない
  ruleSet: { version: string; contentHash: string; status: RuleSetStatus };
  evaluatedFor: { method: RunningTrainingMethod; loadClass: LoadClass };
};
```

   `highIntensityAllowedToday` と `painCheckRequired` は **その日**の状態であり Method に依らない。
   `ruleSet` が計画側の RuleSet と一致しない判断は適用せず `BLOCKED` にする。

3. **readiness 窓の状態を明示する。** §13.3 の「readiness 窓（§12.3）内」は R7（週次）の責務なので、R5 では
   `readinessWindowState: "ACTIVE" | "INACTIVE" | "NOT_EVALUATED"` を入力で受け取る。`NOT_EVALUATED` を
   `ACTIVE` と推測しない（未記入ルールは `ACTIVE` のときだけ適用する）。

4. **公開 API**: `resolveReadinessAction(report, ctx)`。`ctx` は
   `{ planningDate, ageBand: ResolvedAgeBand, method, loadClass?, readinessWindowState }`。
   `loadClass` を渡す場合は RuleSet の `MethodMeta.loadClass` と一致必須（真実の出所は RuleSet 側）。
   判断は server / domain の結果であり、**AI が作って渡すことはできない**（`PlanRequest.readiness` は
   `ReadinessDecision | null` で、生の `ReadinessReport` は `.strict()` が拒否する）。

5. **`AiSafeSubjectContext.ageBand` は `ResolvedAgeBand`**（`AgeBand | "UNKNOWN"`）。生年月日が無い ATHLETE や
   空の GROUP では年齢帯を観測できないため、U12 等へ偽装せず `"UNKNOWN"` を渡す。

6. **§13.2〜§13.4 の判定データは `RuleSet.readinessRules` に置く**（版管理・contentHash の対象）。
   red flag のグループ、成長期ガイダンスの部位・年齢帯、NOT_ASKED の対象年齢帯と loadClass、
   wellness のしきい値（soreness≥4 / soreness=3 / fatigue≥4 / sleepQuality≤2 / シグナル2件以上）、
   SWAP 先の Method と template は TS 側に複製しない。**ID 文字列や説明文のパースで分岐しない**（§8.2 と同じ方針）。

7. **CoachOverride の readiness 対象は `CANCEL_HIGH_INTENSITY` だけ**（`{ kind: "READINESS", action:
   "CANCEL_HIGH_INTENSITY" }`、理由10文字以上、actor=COACH、`confirmedTwice` は要求しない）。
   STOP / MEDICAL_EVALUATION_RECOMMENDED / PAIN_CHECK_REQUIRED / SWAP / USE_LOWER_BOUND / INCREASE_REST は
   override できない（型として書けない）。override して実施した場合も `REQUIRE_COACH_REVIEW` は外さず、
   `readinessApplied` に `CANCEL_HIGH_INTENSITY` を記録し、`safetyOutcome` は `COACH_REVIEW` にする。

8. **SWAP は黙って変換しない。** §13.4 に該当する場合、エンジンは Method を差し替えず
   `INELIGIBLE` + `substitutes`（RuleSet の SWAP 先を列挙し、R3/R4 の eligibility を再評価して通ったものだけ）を返す。
   STRIDE（変更なし）は Method を変えずに続行し、「SWAP は適用していない」ことを finding で明示する。

9. **`Decision` と `AppliedAction` を分ける。** `RunningPrescription.readinessApplied` は
   **実際にこの項目へ適用した effective action だけ**を記録する（raw trigger も、解除・適用不能になった action も
   記録しない）。したがって `CANCEL_HIGH_INTENSITY` を CoachOverride で解除して実施した場合、
   `readinessApplied` に `CANCEL_HIGH_INTENSITY` は入らず、`REQUIRE_COACH_REVIEW` と
   `safetyOutcome = COACH_REVIEW` が残る（健康上の事象そのものは override で消えない）。
   readiness を評価したのに適用結果が何も無い場合は `["NO_CHANGE"]`、`readiness: null`（未評価）の場合は `[]`。
   `RunningPrescription.safetyOutcome`（enum）を追加し、計画処方内の readiness 情報はこの2つとする。実施時の SessionItem は下記 §13.7 の versioned payload を使用する（計画 snapshot は変更しない）。

10. **position の意味**: `USE_LOWER_BOUND` は rest 以外のエンジン配置値に `LOWER_BOUND` の位置上限を与える
    （連立する回数・総量での意味は 12 を参照）。
    位置の制約（既定・positionPreference・confidence・eligibility・readiness）は順序に依存せず、最も低いものが勝つ。
    `INCREASE_REST` は rest の位置を `UPPER_HALF` にする（rest は常に MIDDLE 以上・短くしない）。
    **量に割合や係数を掛けることは一切しない。**

11. **エンジン生成値の recommended 不変条件（readiness は例外にしない）**。
    エンジンが生成した処方は、**使用したすべての `recommended` 制約を満たす**。例外は R4 で既に定義済みの
    コーチ入力（`COACH` / `COACH_OVERRIDE`）と `TEMPLATE_FIXED` の固定値だけであり、**readiness action は例外ではない**。
    `OUTSIDE_RECOMMENDED` は、readiness が自動的に recommended を下回るための逃げ道にしない。

12. **`LOWER_BOUND` の意味（scalar と coupled solver で異なる）**。
    - **独立した scalar フィールド**（`repDistanceM` / `buildUpM` / `repDurationS` 等の通常の `FieldValue`）:
      従来どおり `LOWER_BOUND → recommended.min`。
    - **連立する回数・総量**（fixed rep distance / `totalReps` / `sets` / `repsPerSet` / `sessionVolumeM` /
      `flyVolumeM` / `EligibilityRule.autoGenerationLimits.maxTotalReps`）: セルごとに `recommended.min` へ固定するのではなく、
      **すべての recommended 制約（および `coachEditable` / `hardSafety` / 固定距離）を満たす実行可能解のうち、
      最小 dose の解**を選ぶ。探索の向きだけが §7.3 ②（総本数の最大化）と逆になり、制約は一切緩めない。
      例: 1本 20m 固定・`sessionVolumeM.recommended.min = 60m` なら 2本（40m）へ落とさず 3本（60m）を選ぶ。
    - 実行可能解が無い場合は `ENVELOPE_INFEASIBLE`（readiness を理由に recommended 未満の数値を作らない）。
    - solver が決めた回数の `origin` は `SOLVER_DERIVED`・`position = null` のままにする
      （`position = LOWER_BOUND` へ偽装しない）。`position = LOWER_BOUND` を持つのは `ENGINE_POSITIONED` の値だけ。

13. **raw trigger と effective action を分ける（override / 適用不能後の再正規化）**。
    各入力から signal 単位の **raw trigger**（`{ ruleId, actions }`）を独立に導出し、その和集合を優先順位で
    正規化して effective action を決める。高優先 action が
    **(a) その Method には適用できない**（例: `CANCEL_HIGH_INTENSITY` を LOW/MODERATE の項目へ）、または
    **(b) 有効な `CoachOverride` で解除された** 場合は、**その action だけ**を取り除き、
    残っている raw trigger から優先順位を決め直す。独立した signal から生じた下位 action を消さない。
    同一 signal から `CANCEL` と `SWAP` の両方が出ていた場合だけは、`CANCEL` の解除時に同じ signal の `SWAP` も
    取り除く（同じ判断を二重に適用しない）。`STOP` は再正規化・override の対象外。
    例（pain PRESENT + performanceStatus DOWN）:
    HIGH_* / override なし → `CANCEL`（+ REVIEW）。HIGH_* / valid override → `SWAP`（+ REVIEW、元 selection は
    `INELIGIBLE` + substitutes）。LOW/MODERATE → `CANCEL` は適用不能でも `SWAP`（+ REVIEW）。
    trigger の provenance は判断の中だけで保持し、**処方には保存しない**（raw な健康値も rule id も残さない）。

14. **`highIntensityAllowedToday`**: `stopPlanning` / `CANCEL_HIGH_INTENSITY` / `SWAP_TO_LOWER_LOAD_METHOD` の
    いずれかがある日は `true` にしない（`false`）。未成年の痛み未確認は `"UNKNOWN"`。
    `NO_CHANGE` および `USE_LOWER_BOUND` / `INCREASE_REST` だけの日は `true`。

---

### 13.7 [R11-B2] Versioned item execution persistence（Option B）

`evaluateSessionReadinessAction({ sessionId, readinessReport })` は Coach 用の server Action。入力は strict。
method / loadClass / ageBand / RuleSet identity / actions / gate は client から受け付けない。
raw ReadinessReport は一時的な入力であり、DB・logs・ActionResult・confirmation challenge へ保存／混入しない。

```ts
type PersistedReadinessExecutionStateV1 = {
  schemaVersion: 1;
  actions: ReadinessActionCode[];
  executionGate: "YES" | "NO" | "REQUIRES_COACH_DECISION";
  swapRecommended: boolean;
};
```

- 新規 writer はこの strict v1 object を `SessionItem.readinessActionsJson` へ JSON 保存し、`safetyOutcome` は既存別列へ保存する。Prisma schema / migration は変更しない。既存 UTF-8 JSON 上限検査（prescription 用 32KB ceiling）と正式 health-key guard を適用する。
- 復元保証は **その item の execution gate / 適用される SWAP / 下限・休息延長 advisory / coach review / safetyOutcome**。`highIntensityAllowedToday`、`painCheckRequired`、triggers、transientFindings、stopPlanning の生 flag、evaluatedFor、full Decision、元回答は保存しない。hard STOP の効果は gate=NO に保持する。
- `NO_CHANGE` は「この item について追加 Readiness action なし」であり、健康上問題なし／全高強度許可／痛み確認済みを意味しない。YES は「Readiness による追加の実施停止なし」。NO は「この処方をそのまま実施しない」。確認要求は実施前のコーチ判断が必要であり、B2 は承認 UI / override を追加しない。
- R5 の raw Decision と実際の item 適用を分ける。planning と execution は `readiness/application.ts` の適用ロジックを共有する。CANCEL は HIGH に適用、LOW/MODERATE では非適用。SWAP の KEEP_CURRENT は `resolveSwapTargets()` に従う。STRIDE と TEMPO_EXTENSIVE は同じ LOW・同じ SWAP action でも gate が異なるため、enum 配列だけでは不十分。数値 policy を application に複製しない。
- reload reader は保存された v1 payload + safetyOutcome だけを読み、RuleSet lookup をしない。null は NOT_EVALUATED、旧 enum array は LEGACY_UNVERSIONED（再評価が必要、gate を推測しない）、不正 JSON / 不正 schema / 未知 version は UNREADABLE。読むだけで自動移行しない。旧 array でも rep 記録後の再評価禁止は維持し、コーチ確認用の安全な表示を可能にする。
- Session snapshot のみを使用する。method は plannedPrescriptionJson.method、loadClass は loadSnapshot.loadClass、ageBand は plannedProvenanceJson.inputsDigest.ageBand。UNKNOWN は変換しない。旧 snapshot の loadClass 欠損は current MethodMeta で補完せず評価不可とする。壊れた item が1件でもあれば全 write 0。
- **Readiness RuleSet selection uses `getActiveRuleSet(TrainingSession.date)` with its existing DRAFT fallback semantics.** ACTIVE-only に変更しない。DRAFT は既存 RULESET_DRAFT informational view で示す。処方の保存版への fallback と loader の正式 DRAFT fallback は別であり、前者は禁止。today / Menu plannedDate は選択に使用しない。
- 窓は Session planning snapshot の明示 `plannedAt` がある場合のみ、現在の load-history + 既存 `evaluateWeeklyContext()` で再評価する。作成時 weekly result は流用しない。時刻なしは NOT_EVALUATED、保存時刻と Session date の不整合は評価不可。現在時刻・正午・深夜を補わない。既存履歴 adapter の PARTIAL coverage を維持し、sessionKey で評価対象自身を除外する。RACE / RELAY mapping を複製しない。
- 1 report を全 RUNNING_V2 item へ個別評価する。変更する列は readinessActionsJson / safetyOutcome のみ。全結果を1 transaction で保存し、transaction 内で Session status/date・v2 id集合・kind・rep開始状態を再確認する。並行 submit は最後に完全 commit した評価が勝つ。部分更新は禁止。
- **planned snapshot は不変**。CANCEL / SWAP でも自動再計画・方法変更・代替 item 生成をしない。USE_LOWER_BOUND / INCREASE_REST は advisory であり planned dose/rest は変更しない。実休息は将来B3のRepObservationで扱う。
- 実施前は最新の derived state が以前の payload と safetyOutcome を置換する（append しない）。rep log の null / [] は未開始、正式な entry が1件以上なら再評価禁止。不正ログは fail closed。COMPLETED / CANCELLED は更新しない。LEGACY item は全列不変。

### 13.8 [R11-B3] Rep monitor persistence

- `recordRepAction` の入力は `sessionItemId` と strict `RepObservation` だけ。処方は `plannedPrescriptionJson`、過去ログは `actualRepLogJson` から読み、`monitorRunningPrescription()` を呼ぶ。RuleSet loader、現行 MethodMeta、planning、Readiness 再評価には到達しない。
- 最初の rep だけ §13.7 の厳格な v1 payload + Readiness safety pair を gate として使う。開始後は v1 payload、累積 `safetyOutcome`、RepLog、terminal summary を個別に検証する（runtime safety が初期 Readiness outcome より強くなり得るため、開始前 pair へ偽装して戻さない）。
- `actualRepLogJson` の実施 rep は `MonitorDecision.logEntry` の append-only 配列で、UTF-8 64KB 以下。同一 `(stopPolicyId,setIndex,repIndex)` の置換・編集・削除はしない。R11-B4B1 以降の物理形式は §13.9 の versioned envelope とする。raw `athleteReport`、痛み、部位、red flag は保存しない。`actualHighSpeedExposureJson` は monitor が返した cumulative interval をそのまま最新 snapshot として置換する。
- `SessionItem.stopReason` は列名上の naming debt を持つが、意味は **terminal MonitorAction summary**。新 writer は `END_SESSION_QUALITY` / `STOP_SAFETY` / null だけを保存し、詳細原因は各 `RepLogEntry.reasons[]` に全件残す。`CONTINUE` / `EXTEND_REST` / `END_SET` / `COACH_REVIEW` は null。summary とログの矛盾、未知の historical 値は fail closed。
- `END_SET` は set terminal であり次 set は可能。`END_SESSION_QUALITY` と `STOP_SAFETY` は item terminal。`COACH_REVIEW` は item terminal ではないが、§13.9 の明示 acknowledgement まで pause し、reload 後も log と acknowledgement から fail closed に復元する。
- `safetyOutcome` は実施前には最新 Readiness evaluation の outcome。最初の rep 以降は Readiness 採用値と全 MonitorDecision のうち最も強い outcome を `NONE < COACH_REVIEW < STOP < MEDICAL_EVALUATION_RECOMMENDED` で保持する monotonic lifecycle summary であり、現在の健康状態を表さない。legacy `STOP` は新規生成せず、recordRep は fail closed。
- 読取り時の raw `actualRepLogJson`（最初の rep は加えて `readinessActionsJson` / `safetyOutcome`）を content guard に使い、4 execution 列を1 transactionで更新する。guard miss は全状態を1回だけ読み直し、再度競合すれば stale とする。最初の成功時だけ Session を `PLANNED -> IN_PROGRESS` にし、`done` や legacy actual 列、planned snapshot、Readiness payload、Session の COMPLETED は変更しない。
- `END_SESSION_QUALITY` は正常な予定量完遂にも使われる。load history の DONE は、正常な RUNNING_V2 snapshot + 正式ログ + 最終 `END_SESSION_QUALITY` + `PLANNED_REPS_COMPLETE` / `ATTEMPTS_COMPLETE` + 予定数到達が揃う場合だけ導出する。品質 PASS の意味ではない。ログの無い historical summary、早期終了、`STOP_SAFETY` は PARTIAL。
- B2 safety は feature flag 非依存。Readiness UI / rep logger / monitor persistence / Competition CRUD は今回追加しない。B1/B1.1 confirmation contract は独立のまま。

### 13.9 [R11-B4B1] Runtime COACH_REVIEW acknowledgement

- `actualRepLogJson` は次の strict versioned execution-log envelope を保存する。旧 `RepLogEntry[]` は backward-compatible reader で読み続けるが、read だけでは変換しない。最初の rep、旧配列への次 rep、または旧配列の review acknowledgement が成功した時点から、新 writer は常に v1 を書く。unknown version・壊れた配列/envelope は空配列へ置換せず fail closed。

```ts
type RuntimeCoachReviewIdentity = {
  stopPolicyId: StopPolicyId;
  setIndex: number;
  repIndex: number;
};

type RuntimeCoachReviewAcknowledgement = {
  review: RuntimeCoachReviewIdentity;
  acknowledgedAt: IsoDateTime; // server clock
};

type ActualRepLogStateV1 = {
  schemaVersion: 1;
  reps: RepLogEntry[];
  coachReviewAcknowledgements: RuntimeCoachReviewAcknowledgement[];
};
```

- acknowledgement は owner の `IN_PROGRESS` / `RUNNING_V2` item に対する明示 Coach action で、現在の最新 unresolved `COACH_REVIEW` entry と `(stopPolicyId,setIndex,repIndex)` が完全一致するときだけ append する。random token・confirmation challenge・client timestamp・`acknowledgedBy` は保存しない。同じ review の再送は audit record を増やさず `ALREADY_ACKNOWLEDGED`。古い identity、terminal state、review 不在、過去 review 未確認のまま後続 rep がある不整合状態は fail closed。
- ack は元の `RepLogEntry` を変更せず、synthetic rep も作らない。後続 rep 後も acknowledgement を保持する。新しい `COACH_REVIEW` は新しい identity の ack を必要とし、古い ack を流用しない。R8 monitor と load-history adapter へ渡すのは envelope の `reps` だけで、ack metadata は rep 数・露出・DONE/PARTIAL 判定へ影響しない。
- ack の意味は「この runtime review を確認し、次 rep 入力を再開可能にする」だけであり、安全問題の解消・医学的安全・quality 成功を意味しない。`safetyOutcome`（monotonic lifecycle summary）、terminal summary の `stopReason`、Readiness state、planned snapshot は一切変更しない。
- acknowledgement を含む envelope 全体に health-key guard と UTF-8 64KB 上限を適用する。保存可能な ack metadata は identity 3 field と server-generated `acknowledgedAt` だけ。raw health information / reason text / free text は保存しない。
- ack write は raw `actualRepLogJson`、Session status、prescription kind、planned prescription snapshot、`safetyOutcome`、`stopReason` の CAS guard を使い、`actualRepLogJson` だけを atomic に更新する。guard miss は全状態を最大1回読み直し、既に同じ ack があれば idempotent success、review が変われば stale、terminal なら拒否する。

### 13.10 [R11-B4B2] Session execution presentation DTO

- `/sessions/[id]` の server page は既存の owner-scoped Session + SessionItems 読取り結果だけから、RUNNING_V2 itemごとにread-only execution DTOを構築する。Menu / Competition repository、RuleSet loader、Readiness再評価、Monitor再実行、DB writeを追加しない。LEGACY itemは既存row表示のまま、mixed SessionではRUNNING_V2 itemだけにDTOを付ける。
- DTOのauthorityは保存済み `plannedPrescriptionJson`、B2 Readiness reader、B3 started-execution reader、B4B1 execution-log envelope reader、`actualHighSpeedExposureJson`、累積 `safetyOutcome`。Client Componentへraw `plannedPrescriptionJson` / `plannedProvenanceJson` / `actualRepLogJson` / `readinessActionsJson`を渡さない。planned prescriptionはsnapshotをparseして既存R10 presenterへ渡し、exact RuleSetが利用できない場合も処方表示とexecution stateは分離して継続する。
- execution machine stateは `NOT_STARTED` / `READY_FOR_NEXT_REP` / `END_SET` / `COACH_REVIEW_ACK_REQUIRED` / `TERMINAL` / `UNREADABLE`。`END_SET`はitem terminalではなく次setへ進める状態。terminalは`END_SESSION_QUALITY`と`STOP_SAFETY`を日本語messageで区別し、raw enumを表示しない。壊れたsnapshot/log、unknown envelope、summary/log矛盾、未ack review後の後続repはitem単位でfail closedとし、Session page全体を失敗させない。
- pending runtime reviewは最新のunresolved `COACH_REVIEW`だけを、内部action payload用の `(stopPolicyId,setIndex,repIndex)` と安全な日本語messageへ射影する。ack済みreviewはpendingにせず、2回目のreviewには別identityを返す。capabilityはUX用であり、server Actionの認可・validationを置き換えない。
- capabilityは既存reader stateからのみ導出する。`canSubmitReadiness`はactive・snapshot/log readable・未開始、`canRecordRep`はfirst-rep gate=YESまたはstarted readerが次repを許す状態、`canAcknowledgeCoachReview`はIN_PROGRESSかつ最新unresolved reviewの場合だけtrue。COMPLETED / CANCELLED、blocked/coach-decision readiness、terminal、review待ち、unreadableでは該当操作をfalseにする。
- latest monitorは保存済み最新RepLogEntryのaction / quality / reasons / timing / time / actual restを既存label registryで表示する。reasonは全件・domain順を維持し、primary reasonを作らない。`nextRepRestS`はRepLogEntryに保存されないtransient Decision値なので、reload DTOではnull（利用不可）とし推測しない。
- progressは保存済みrep数とsnapshotの予定数（R8と共通helper）を別々に示す。予定量完遂とquality PASSを混同しない。exposureは正式QuantityInterval schemaでparseし、range / unit / source / confidenceを表示する。`safetyOutcome`は現在の健康状態ではなくexecution lifecycle中の最強outcomeであり、NONEも「安全」と断定しない。
- DTOはplain JSON-safe dataのみ。raw health observation、Zod error、invalid JSON本文を含めない。B4B2はDTO/prop wiringだけで、Readiness form、rep logger、ack button、その他mutation UIを描画しない。新しい操作UIの表示は後続B4B3でfeature flag境界を接続する。

### 13.11 [R11-B4B3] Session execution UI

- 新しいReadiness / rep記録 / runtime Coach review確認UIは、server pageが `RUNNING_V2_UI_ENABLED === "true"` と判定し、かつRUNNING_V2 itemに安全な§13.10 DTOがある場合だけ表示する。flag OFFとLEGACY itemは既存Session rowのmarkup・操作を維持する。DTO capabilityはUX上の表示・disableにだけ使い、最終authorityは各Server Actionのowner scope・schema validation・CAS guardである。
- Readiness formは正式 `ReadinessReportSchema` の選択式fieldだけを送信する。`reportedAt` は実際に確認した日時の明示入力であり、Client current timeで補完しない。痛み、部位、red flag、soreness、fatigue、sleep等の入力はcomponent memory内だけのtransient stateであり、localStorage / sessionStorage / IndexedDB / cookie / URL / analyticsへ保存しない。成功後はhealth-sensitive stateをclearし、server DTOをrefreshする。Clientは尺度値からaction・gateを判定しない。
- rep loggerは正式 `RepObservationSchema` のfieldだけを送り、set/rep sequence、timing、quality、stop、exposureをClientで導出しない。共有next-index authorityがない間はsetIndex / repIndexを明示入力とする。VIDEO fpsは未入力を推測せず、UNKNOWN / coach-only判定をerror扱いしない。raw athleteReportはtransient inputで、成功後にclearする。
- 保存済みmonitor表示はlatest RepLogEntryを§13.10の日本語DTOから描画し、reasonを全件・domain順で示す。`nextRepRestS`はrecordRep成功直後のtransient resultにだけ表示し、reload後に再構成しない。END_SETはitem terminalと表示せず、END_SESSION_QUALITYとSTOP_SAFETYを区別する。
- runtime `COACH_REVIEW` acknowledgementは、pending DTOとcapabilityの両方がある場合の明示button clickだけで送信する。payloadはsessionItemIdとreview identityだけ。閲覧・banner close・次rep入力をackとみなさず、ack文言も安全性・医学的解決を意味しない。成功、already-acknowledged、stale、terminal race後はserver DTOをrefreshし、Clientだけでcapabilityを変更しない。
- 同一itemのReadiness / rep / ack mutationは共有pending lockで並列送信とdouble submitを抑止する。競合時もClientでdomain stateをpatchせずrefreshする。フォームはlabel / fieldset / legend / aria-live / keyboard focusを備え、主要button・入力はmobileで約44pxのtouch targetを確保する。Server Actionのsafe messageだけを表示し、raw enum、Zod issue、JSON、database errorは表示しない。

### 13.12 [R11-B5] Competition CRUD

- Competitionは計画用calendar entityとして、一覧・作成・詳細・編集・削除をCoach UIへ接続する。B5はCompetitionからTrainingSessionを生成せず、RACE / RELAY load event、result、placing、entry管理を追加しない。CRUD後のMenu / Session snapshotも自動再計画しない。
- 書込みは既存 `competitionInputSchema` だけをauthorityにし、name 1〜120文字、実在するdate-onlyの必須開始日、nullable endDate、`endDate >= date`、正式CompetitionPriority、nullable note 1000文字を検証する。空のendDate / noteはnullのままで、今日・開始日に補完しない。重複名・日程overlapは禁止規則が無いため許容する。
- ownerIdはserver側の既定Coachから決定し、Clientから受け取らない。find / update / deleteもowner scopeを必須にし、他ownerはNOT_FOUND相当で扱う。priorityは日本語labelをpresentation registryから表示し、raw enumを表示しない。
- DBのCompetition dateはUTC 0:00で保存されたdate-onlyとして`YYYY-MM-DD`へ戻し、表示は数値成分から組み立てる。browser local timezoneに再解釈して前日へずらさない。メモはReact textとして描画し、HTMLとして挿入しない。
- Competition削除は明示confirmationを必要とする。Prisma relationの`TrainingSession.competitionId onDelete: SetNull`により過去Sessionは残る。Competition CRUDは`RUNNING_V2_UI_ENABLED`に依存せず、planning / weekly / monitor / ReadinessをAction内で実行しない。

### 13.13 [R11-B6] Competition actual participation

- Competitionは予定calendarであり単独ではloadを作らない。Coachの「大会実績を記録」により、開催期間内かつ未来でない日へ
  `status=COMPLETED` / `sessionKind=COMPETITION` / item 0件のTrainingSessionを1件作る。titleはCompetition.nameの作成時snapshot。
  priorityやrace resultはsnapshotせず、RuleSet / planner / readiness / monitorを呼ばない。
- 1大会・1開催日を1実績とし、idempotency keyは `(ownerId, competitionId, date)`（COMPETITION Session内）。categoryはkeyに含めない。
  owner/range/existing確認とcreateはSQLite Serializable interactive transaction内で行い、write/lock conflict時はtransaction全体を最大1回再実行する。
  exactな再送は`ALREADY_RECORDED`、別category、cancelled、破損、既存重複は`CONFLICT_EXISTING_RECORD`。silent mergeしない。
- category集合は作成後immutable。訂正はowner-scopedに大会Sessionを削除して再登録する。通常Sessionのdate/status編集、item追加、実施UIからは
  Competition Sessionを変更できない。Competition calendarの改名・日程変更は既存Sessionのtitle/date/categoryを変更せず、calendar削除後も
  SetNullされたSession snapshotからloadを維持する。
- `competitionLoadCategories`が存在する新形式の空・重複・逆順・未知値、singularとの同時存在、unknown versionはUNREADABLE。
  HIGH履歴を消して計画を続けず、load-historyをtyped failureにしてplanning / readiness等の新規writeを止める。JSON自体をparseできない旧行、
  category keyの無い旧行は識別不能なhistorical compatibilityとしてRACE fallbackを維持する。

## 14. Phase / Competition / Taper

### 14.1 役割の分離（二重管理しない）[ENGINE-POLICY]

| 概念 | 保存場所 | 時間スケール | 変えるもの | 変えないもの |
| --- | --- | --- | --- | --- |
| Phase | `MenuTemplate.phase`（既存） | 数週間 | methodPriority（候補の並び）、TRANSITION の自動生成可否、volume の位置上限（§9.3）、種目特異性の優先 | hard stop、pain gate、rest を短くすること、tier、**fatigueTolerance（phase の属性として存在させない）** |
| CompetitionPriority | `Competition.priority`（新規 §16） | 大会の前後数日 | 大会ウィンドウ規則、近接時の eligibility、位置上限、taper ガイダンス、race の負荷イベント化 | 同上 |

- 日本の中高（4–10月にほぼ毎月大会）への対応: 毎回の記録会は `TRAINING_MEET` / `NORMAL` として登録し、**14日 taper を自動適用しない**（T-PH-02）。[SOURCE-BACKED 方針: ChatGPT DR / Fable M-10]

#### [R7 correction] Phase × Competition の合成規則（旧「大会規則が phase より優先」の記述を撤回）

初版の「計画日が優先度 NORMAL 以上の大会ウィンドウ内にあるとき、eligibility と位置は大会規則が phase より優先」という
表現は、**上書き（override）**と読める点で不正確だった。実装（R7）で確定した規則は次のとおり:

- **Competition は Phase を時間的に局所化したものであり、Phase を上書き（override）しない。両者は dose position の
  上限として交差（intersection）する。** 最終的な dose position cap は phase の cap・competition window の cap・
  confidence・readiness・weekly context・コーチの preference のうち、**最も低い（制約が強い）位置**を採る
  （既存の `lowestPosition()` が全候補をまとめて合成する。「大会が来たら phase を無視する」処理ではない）。
- **大会側の例外（exception）は、その大会規則自身が課す autogen block からの除外にすぎず、他レイヤー
  （phase の TRANSITION ブロック・weekly の48h/72hガード・confidence 由来の制限・readiness・pain gate・
  plausibility）を一切解除しない。** 例: NORMAL n=1 の STRIDE / ACC≤20m 例外は「NORMAL n=1 の autogen block」
  からの例外であり、TRANSITION 期の HIGH_* autogen block や readiness の STOP を解除しない。
- **methodPriority（候補の並び順）だけは Competition context を候補選定の参考情報として優先的に使ってよい。**
  これは `selection`（実際に何を処方するか）を自動で変えるものではなく、AI-safe context 側の候補提示にのみ効く。
- pain gate・hardSafety・rest の下限は phase からも competition からも一切緩められない（T-PH-01）。

### 14.2 Phase ごとの methodPriority

| Phase | 候補の優先順（先頭ほど優先） | 位置上限 | 自動生成の制限 |
| --- | --- | --- | --- |
| PREPARATION | ACCELERATION, RESISTED_SPRINT, TEMPO_EXTENSIVE, MAX_VELOCITY（少量）, STRIDE | UPPER_HALF | なし |
| PRE_COMPETITION | MAX_VELOCITY, SPRINT_ENDURANCE_SHORT, EVENT_APPROACH_SPEED, LONG（200/400のみ）, ACCELERATION | MIDDLE | なし |
| COMPETITION | MAX_VELOCITY, ACCELERATION, EVENT_APPROACH_SPEED, SPRINT_ENDURANCE_SHORT, STRIDE | LOWER_HALF | なし |
| TRANSITION | STRIDE, TEMPO_EXTENSIVE | LOWER_BOUND | HIGH_* を自動生成しない（手動は可） |
| null | 並び替えなし | MIDDLE | なし |

- 判断: 方向（準備期=加速・抵抗・テンポ多め、試合前=最高速・特異的持久、試合期=強度維持・量削減、移行期=構造化された高強度を休止）は [SOURCE-BACKED]（Haugen 2019 を Perplexity/ChatGPT DR が報告）。順序と位置は [ENGINE-POLICY]。
- 「intensity −5/+2/−15pp」と「volume ×1.2/0.7/0.5」は**使わない**（全DRが根拠なしと報告）。
- PRE_COMPETITION のメニューには INFO「準備期から試合期への切替時期はハムストリング傷害が多いと報告されています」を表示（[SOURCE-BACKED] Haugen 2019 を Claude DR が報告）。数値の制限は置かない。

### 14.3 大会ウィンドウ規則（D = 大会日、d = 計画日、n = D − d 日）[ENGINE-POLICY・日数は provisional]

| priority | n = 0（当日） | n = 1 | n = 2–4 | n = 5–7 | n = 8–14 |
| --- | --- | --- | --- | --- | --- |
| TRAINING_MEET | race を負荷イベント化。他の HIGH_* は REQUIRE_COACH_REVIEW | HIGH_METABOLIC を自動生成しない | 制限なし | 制限なし | 制限なし |
| NORMAL | 同上 | HIGH_* は自動生成しない（例外: STRIDE と ACC ≤20m を LOWER_BOUND で） | n=2 のみ HIGH_METABOLIC を自動生成しない | 制限なし | 制限なし |
| IMPORTANT | 同上 | NORMAL の n=1 と同じ | HIGH_METABOLIC を自動生成しない・位置 LOWER_HALF | 新規刺激禁止（直近28日に使っていない template は REQUIRE_COACH_REVIEW） | 制限なし |
| PEAK × ADVANCED | 同上 | NORMAL の n=1 と同じ | IMPORTANT と同じ + 位置 LOWER_BOUND | 新規刺激禁止 + LONG INCOMPLETE 不適格 | taper ガイダンス（§14.4）・量の位置 LOWER_HALF・強度参照は変えない |
| PEAK × DEVELOPMENTAL | 同上 | NORMAL の n=1 と同じ | HIGH_METABOLIC を自動生成しない | 新規刺激禁止 + HIGH_METABOLIC（LONG/TI/SES）を自動生成しない | **% taper を適用しない**（位置は phase 規則のまま） |

- 複数の大会ウィンドウが重なる場合は、すべてを適用して最も制約の強い結果を採用。
- 「前日は休養かごく少量の priming、新しい刺激は入れない」は [SOURCE-BACKED 方向]（ChatGPT/Perplexity DR の best practice 表）。「5–7日前から新規刺激・大きな解糖系負荷を入れない」を youth に使うのは [ENGINE-POLICY]（Fable H-8）。

### 14.4 Taper
- Bosquet 2007 の約2週間・volume −41〜60%・intensity/frequency 維持は pooled competitive-athlete の general taper context であり、**短距離特異的な source-backed 推奨値ではない**。`EV_BOSQUET_2007_TAPER` は CONTEXT_ONLY として保持する。
- 現行 sprint engine の出力は **ENGINE_POLICY / ADVANCED tier × PEAK の provisional guidance** に限る。出力は「週の総量を大会前の基準週から減らす目安」という Finding と、量フィールドの位置 LOWER_HALF のみ。sprint-specific primary source が得られるまでは、Bosquet 値を sprint prescription と表示しない。
  - 基準週の量（直近4週の週平均）が履歴カバレッジ不足で計算できない場合は、数値を出さず文章のみ。
- [ENGINE-POLICY] PRE / CIRCA / EFFECTIVE_UNKNOWN / DEVELOPMENTAL に **% の量削減を自動適用しない**。§14.3 の「新規刺激を入れない・大きな解糖系負荷を近接させない」で代替する。
- Charlie Francis 型 10日 taper 等の個別コーチ実践はテンプレートとしても実装しない（v2 範囲外、OPEN-18）。

### 14.5 [R7 representation errata]（R7 実装で確定した表現）

- **§14 は一貫して暦日（`plannedDate`）ベースで動く。** `n = D − d` の大会近接判定・新規刺激判定・taper の4週基準値は
  いずれも `plannedAt`（時刻）を要求しない。`plannedAt` を必須にするのは §12 の厳密な48h/72h 窓だけであり、
  `plannedAt` が無いメニューでも §14 のガイダンス・自動生成停止・dose position 上限は評価できる。
- **`dosePositionCap` という新しい概念は作らない。** `position` 変数（sets/reps/rep distance-or-duration など「量」
  フィールドの位置）は既存の `placement.ts` の `lowestPosition()` にそのまま合流させ、`intensityPercent` /
  intensity reference / target race pace / Vmax reference には一切触れない（元から `position` はこれらの解決に
  使われていない構造だったため、既存の合成ロジックを再利用するだけで dose と intensity の分離が保証される）。
  Taper の 41–60% も同様に「dose position の上限」としてだけ反映し、`RunningPrescription` の数値へ倍率を
  掛けることは一切しない（`volume *= 0.5` のようなコードは存在しない）。
- **`ELIG_SES_POST` の OR 条件（[R7 pre-commit correction] §4.5 の自然文どおり正確に表現する）。**
  §4.5 の条件「tier=ADVANCED、または (POST & tier≥DEVELOPING & phase≠TRANSITION)」は論理和（OR）であり、
  `EligibilityConditions` の単一 AND では表現できない。当初 R7 は「TRANSITION を tier に関わらず一律で
  ブロックする」単純化（`requiresPhaseNotIn: ["TRANSITION"]` を無条件に適用）を採用したが、レビューで
  **「最終結果（phase gate 込み）が同じに見えても、population eligibility そのものの意味を変えてしまう」**
  という指摘を受けて撤回した。population eligibility（この行の条件を満たすか）と、phase 由来の自動生成停止
  （TRANSITION の `blockedAutogenLoadClasses`）は別レイヤーであり、片方の結果を理由にもう片方を書き換えない。
  - 正しい表現: `EligibilityConditions.anyOf: EligibilityConditionBranch[] | null`。非 null のときは平坦な
    `requires*` を使わず、branch のどれか1つを満たせば行の条件は満たされる（OR）。ELIG_SES_POST は
    `anyOf: [{requiresEnvelopeTier: "ADVANCED"}, {requiresTrainingAgeTiers: ["DEVELOPING","TRAINED","ADVANCED"], requiresPhaseNotIn: ["TRANSITION"]}]`。
    行自体が `maturityCategory: "POST"` に紐づいているため、branch 側に POST 条件を重複させない。
  - generic evaluator（`planning/eligibility.ts` の `evaluateEligibilityConditionVerdict`）は branch ごとに
    `"MET" | "UNMET" | "PHASE_UNRESOLVED"` を判定し、**どれか1つの branch が MET ならその時点で行全体が MET**
    （他の branch が UNMET でも PHASE_UNRESOLVED でも関係ない）。phase に依存しない branch（ADVANCED tier）は、
    phase が未評価（null）でも独立に MET/UNMET が決まる — 「phase 条件がどれか1つでもある行は phase が
    無ければ全体が未評価」という扱いはしない。SES 専用の TS 分岐・conditionNote / ruleId のテキスト解析は
    一切持たない（method・ruleId に依存しない generic な OR 評価器）。
  - 結果として、ADVANCED tier の被験者は phase の値・評価有無に関わらず population eligibility は常に
    MET（真の AUTO へ昇格しうる）。TRANSITION 期にそれでも AI/SYSTEM の自動生成が止まるのは、population
    eligibility とは独立な phase の autogen block レイヤー（`PHASE_AUTOGEN_BLOCKED` finding。COACH は
    manual + review で継続可）によるものであり、population 側を MANUAL に落として実現しているのではない。
  - 数値・科学的データは変えていない（`conditionNote` の文言も変更していない。既存の PRE/CIRCA/
    EFFECTIVE_UNKNOWN の SES 行、および他63行の eligibility outcome/overrideAllowed/conditionNote は不変）。
- **`CompetitionRef` は R9 まで DB モデルを持たない。** `menuContext.competitions: CompetitionRef[]` として
  domain 型だけを受け取る（id 重複は拒否）。
- **[R10-B2.1 errata] `CompetitionRef.endDate?: IsoDate | null`（登録された大会開催期間）。**
  `CompetitionRef = { id: string; date: IsoDate; endDate?: IsoDate | null; priority: CompetitionPriority }`。
  - `endDate` が null / 省略なら `date` の1日開催（`plannedDate === date` だけが大会当日）。R7 までの single-day の結果と完全に同じ。
  - `endDate` があれば **`date <= plannedDate <= endDate`（両端 inclusive）を大会期間内**とし、§14.3 の `n = 0`
    （大会当日の行。R6 の `AggregationContext.competitionDay = true`）として扱う。「その日に実際に出場種目がある」と
    推測する意味ではなく、登録された開催期間という保守的な calendar context。
  - 大会ウィンドウの距離は開催期間を1つの区間として計算する: 開催前 `n = date − d`、期間中 `n = 0`、終了後
    `n = endDate − d`（負。対象外）。開催2日目以降が「開始日から見て大会後」の負値になり制限が外れる事故を防ぐ。
  - `endDate < date` は swap せず validation error（`competitionRefSchema` と Competition 書込みの `competitionInputSchema` の両方）。
  - 判定は competition domain（`competition/windows.ts` の `daysUntilCompetition` / `isWithinCompetitionPeriod` /
    `resolveCompetitionDay`）だけが持ち、application layer は日付比較を書かない。Competition repository → CompetitionRef の
    adapter（`listCompetitionRefs`）は planner（R10-B1）と session 評価（R10-B2）で共有する。
  - [B5 cleanup 候補] `competition/windows.ts` の旧 helper `isCompetitionDay(matched)`（RuleSet の `raceIsLoadEvent` を見る）は
    現在どこからも呼ばれていない。R10-B3 では削除しない（presentation phase に domain cleanup を混ぜない）。
- **`competitionRules` はフラットな行（`priority | null`, `tier | null`, `dayMin`, `dayMax`, ...）として持ち、
  優先度文字列の巨大な switch は書かない。** 複数の大会ウィンドウが重なる場合はマッチした全行を集め、
  `blockedAutogenLoadClasses` は和集合、`dosePositionCap` は最も制約の強い（LOWER_BOUND 側の）値を採用する
  「最も制約の強い結果が勝つ」合成（configuration の配列順序に依存しない）。
- **新規刺激（new stimulus）は `LoadEvent.templateId` の完全一致だけで判定する。** Method 名だけの一致や表示名の
  一致では判定しない。`coverage28d` が `COMPLETE` でない場合は「新規ではない」と結論せず `NOT_DETERMINABLE`
  （AI/SYSTEM は自動生成不可、COACH は手動 + REVIEW）を返す。
- **Taper ガイダンスは `tier=ADVANCED` かつ `priority=PEAK` かつ `n∈[8,14]` のときだけ**存在する。
  DEVELOPMENTAL（および PRE/CIRCA/EFFECTIVE_UNKNOWN のような ADVANCED に解決されない成熟度）には
  taper の % ガイダンス行自体を RuleSet に用意しない（phase の position 規則だけが適用される）。

---

## 15. Existing Data Model Integration

### 15.1 既存モデルとの対応

| 既存モデル | v2 での扱い | 判断 |
| --- | --- | --- |
| `Exercise` | **使わない・変えない**。v2 項目は `exerciseId = null` を必須にする。参考動画は `prescriptionJson.referenceExerciseIds`（表示専用）に持つ | [ENGINE-POLICY]（`createSessionFromMenu` の名前スナップショット規則 `exercise?.name ?? displayName` を変えずに済む） |
| `MenuTemplate` | `phase` をそのまま使う。対象グループと計画日を `runningContextJson` に保存（健康情報は含めない） | [ENGINE-POLICY] |
| `MenuBlock` | 変更なし | — |
| `MenuItem` | `prescriptionKind` で LEGACY / RUNNING_V2 を判別。v2 の構造化データは新列 + JSON | [ENGINE-POLICY] |
| `TrainingSession` | `sessionKind`（TRAINING / COMPETITION）、`competitionId`、`planningSnapshotJson` を追加 | [ENGINE-POLICY] |
| `SessionItem` | v2 の計画スナップショット列、`loadCategory`、実施ログ列を追加 | [ENGINE-POLICY] |
| （新規）`Competition` | 大会カレンダー（日付・優先度）。計画用であり、エンジンの第4層ではない | [ENGINE-POLICY] |

### 15.2 既存列への投影（互換のため v2 でも必ず埋める）[ENGINE-POLICY]

| 既存列 | v2 項目で入れる値 |
| --- | --- |
| `displayName` | template の日本語ラベル + 主要値（例「フライ20m（助走30m）」「流し 100m」）。enum キーを出さない |
| `sets` / `reps` | `sets.value` / `repsPerSet.value`（両方必須） |
| `distanceMeters` | DISTANCE: 1本の距離／FLY: build-up + fly／DURATION: null／SPLIT: 区間合計／ATTEMPTS: 助走距離 or null |
| `durationSeconds` | DURATION: 1本の時間／それ以外 null |
| `restSeconds` | `rest.repRestS.value`（下限として表示） |
| `intensityPercent` | 数値%目標がある場合（TE/TI）の区間中央値を整数化。**MAX_INTENT / RELAXED_SUBMAX では null** |
| `loadKg` | null |
| `note` | コーチの自由指示のみ。**エンジンの rationale を書き込まない** |
| `exerciseId` | null |

- 投影により、既存の `formatPrescription()` / `estimateSeconds()` / 練習記録画面の planned* 表示がそのまま動く。
- legacy 用の集計（§11.2 の sets/reps 区間化）は `prescriptionKind = "LEGACY"` の項目にだけ適用する。

### 15.3 既存関数への影響

| 関数 | 変更 |
| --- | --- |
| `createSessionFromMenu()` | 新列を**コピーするだけ**追加（§17）。**エンジンの plan() もルールセットも集計・週次評価も呼ばない**。[R9] application layer（R10）から渡された `SessionPlanningEvaluationInput` と RuleSet 非依存のスナップショット検証結果を `TrainingSession.planningSnapshotJson` に保存（渡されなければ NOT_EVALUATED） |
| `duplicateMenu()` | 新列を値のままコピー（`ruleSetVersion` も旧版のまま）。UI に「旧ルール版で作成」表示と「現行ルールで再計算」ボタン（押した場合のみ新しい provenance） |
| `updateMenuItemAction` | `prescriptionKind = "RUNNING_V2"` の項目を拒否（v2 は専用 Action で編集） |
| `moveMenuItemAction` / `deleteMenuItemAction` | 変更なし。実行後に集計を再評価（R10） |
| legacy `suggestPrescription()` | R0 で凍結。R6 で出力に plausibility Finding を**追加するだけ**（数値は変えない） |
| `menu-item-form.tsx` | R10 で走系 legacy Kind の「推奨処方を入れる」を無効化し、v2 への導線を表示 |

### 15.4 新規 repository / action

| ファイル | 役割 |
| --- | --- |
| `src/infra/repositories/running-item-repository.ts` | v2 MenuItem の保存・読込（JSON の Zod 検証を含む） |
| `src/infra/repositories/load-history-repository.ts` | TrainingSession/SessionItem → `LoadEvent[]`（§12.2） |
| `src/infra/repositories/competition-repository.ts` | Competition CRUD |
| `src/actions/running-actions.ts` | `planRunningItemAction` / `editRunningItemAction` / `overrideRunningItemAction` / `recalculateWithActiveRuleSetAction` |
| `src/actions/competition-actions.ts` | 大会の登録・編集 |
| `src/actions/_actor.ts` | `createCoachActor()`（server-only。AI 経路から import 禁止） |

- Server Action の3ステップ（検証 → repository → revalidatePath）は維持する。エンジン呼び出しは「検証」と「repository」の間に入る純粋関数。[ENGINE-POLICY]

---

## 16. Required Schema Changes

**結論: schema 変更が必要。** 過去の処方を正しく再現・説明することを DB 変更の最小化より優先する（要件§28）。**今回は migration を実行しない。** 実行は R9。

### 16.1 Prisma 差分案

```prisma
model MenuTemplate {
  // …既存…
  /// RunningMenuContext（Zod・schemaVersion 付き）。対象グループ・計画日・練習時間。健康情報は保存しない
  runningContextJson String?
}

model MenuItem {
  // …既存…
  prescriptionKind       String  @default("LEGACY")   // LEGACY | RUNNING_V2
  runningMethod          String?
  sessionTemplateId      String?
  recoveryStructure      String?                      // FULL | INCOMPLETE（LONG のみ）
  buildUpDistanceMeters  Float?
  flyZoneDistanceMeters  Float?
  setRestSeconds         Int?
  intraRepRestSeconds    Int?
  intensityReferenceKind String?
  prescriptionConfidence String?
  ruleSetVersion         String?
  ruleSetContentHash     String?
  prescriptionJson       String?                      // RunningPrescription（≤32KB）
  provenanceJson         String?                      // Provenance（≤16KB）
  rationale              String?                      // 生成時点の日本語テキスト（≤4000字）

  @@index([prescriptionKind, runningMethod])
}

model TrainingSession {
  // …既存…
  sessionKind          String       @default("TRAINING")  // TRAINING | COMPETITION
  competitionId        String?
  planningSnapshotJson String?                            // 作成時の集計・週次評価・スナップショット検証結果
  competition          Competition? @relation(fields: [competitionId], references: [id], onDelete: SetNull)

  @@index([ownerId, sessionKind, date])
}

model SessionItem {
  // …既存…
  prescriptionKind              String  @default("LEGACY")
  runningMethod                 String?
  sessionTemplateId             String?
  recoveryStructure             String?
  plannedBuildUpDistanceMeters  Float?
  plannedFlyZoneDistanceMeters  Float?
  plannedSetRestSeconds         Int?
  plannedIntraRepRestSeconds    Int?
  plannedIntensityReferenceKind String?
  plannedPrescriptionConfidence String?
  ruleSetVersion                String?
  ruleSetContentHash            String?
  plannedPrescriptionJson       String?
  plannedProvenanceJson         String?
  plannedRationale              String?
  loadCategory                  String?   // 週次文脈用スナップショット（legacy 項目にも入れる）
  actualRepLogJson              String?   // ActualRepLogStateV1（旧 RepLogEntry[] 読取可。痛みの部位は含めない）
  actualHighSpeedExposureJson   String?   // QuantityInterval（source 付き）
  stopReason                    String?
  safetyOutcome                 String?
  readinessActionsJson          String?

  @@index([trainingSessionId, loadCategory])
}

model Competition {
  id        String    @id @default(cuid())
  ownerId   String    @default("default-coach")
  name      String
  date      DateTime
  endDate   DateTime?
  priority  String    @default("NORMAL")   // TRAINING_MEET | NORMAL | IMPORTANT | PEAK
  note      String?
  sessions  TrainingSession[]
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@index([ownerId, date])
}
```

### 16.2 列にするか JSON にするかの基準 [ENGINE-POLICY]

| 列にしたもの | 理由 |
| --- | --- |
| prescriptionKind, runningMethod, sessionTemplateId, recoveryStructure | 一覧・フィルタ・集計・週次履歴の検索に使う |
| buildUp / flyZone / setRest / intraRepRest | 要件§10・§28 の必須分離。JSON が壊れても主要構造を表示できる |
| ruleSetVersion, ruleSetContentHash, prescriptionConfidence | 「どの版で出たか」を SQL で追跡する |
| loadCategory | 週次文脈を Exercise 削除後も成立させる |

| JSON にしたもの | 理由 |
| --- | --- |
| prescriptionJson | 3層 range・位置・露出区間・stop policy・tolerance を丸ごと保存（再現性） |
| provenanceJson | 入力要約・actor・override 履歴・evidenceIds（構造が版で変わりうる） |
| actualRepLogJson | versioned execution-log envelope（rep ごとの可変長ログ + runtime review acknowledgement） |

- PostgreSQL 移行時は `String` の JSON 列を `Json` 型、列挙 String を enum に戻す（既存の SQLite 方針と同じ）。

### 16.3 Provenance（`provenanceJson`）

```ts
export type Provenance = {
  schemaVersion: 1;
  engineVersion: string;                       // package.json version + git 短縮 hash（ビルド時注入）
  ruleSet: { version: string; contentHash: string; status: "DRAFT" | "ACTIVE" | "RETIRED" };
  generatedBy: {
    proposer: { kind: "ENGINE" } | { kind: "AI_PLANNER"; provider: string; model: string; requestId: string };
    createdByCoach: boolean;
    acceptedByCoachAt: IsoDateTime | null;
  };
  inputsDigest: {                              // 健康情報を含めない
    tier: EnvelopeTier;
    ageBand: ResolvedAgeBand;                  // = AgeBand | "UNKNOWN"（[R10-B1.1] core の AgeBand は変えない）
    maturityEffective: string;
    trainingAgeTier: TrainingAgeTier | "UNKNOWN"; // = ProvenanceTrainingAgeTier（[R10-B1.1] core の TrainingAgeTier は変えない）
    phase: TrainingPhase | null; plannedDate: IsoDate | null; competitionWindows: string[];
    referenceKinds: string[]; historyCoverage72h: "COMPLETE" | "PARTIAL" | "NONE";
    readinessActions: ReadinessActionCode[];
  };
  evidenceIds: EvidenceId[];
  confidence: { prescription: PrescriptionConfidence; directness: Directness; inputData: Confidence };
  coachEdits: Array<{ at: IsoDateTime; field: EnvelopeField | "approachDistanceM"; from?: number; to: number }>;
  overrides: Array<{ at: IsoDateTime; target: CoachOverride["target"]; from?: number; to?: number; reason: string; confirmedTwice?: boolean }>;
  aiReason: string | null;                     // AI の説明文（数値・出典除去済み §18）
  findingConfirmations?: Array<{ code: string; at: IsoDateTime }>; // [R10-B4A] 明示確認の監査記録（optional）
};
```

- **[R10-B1.1 errata] `inputsDigest.ageBand` / `trainingAgeTier` の正確な型。** 当初のコードブロックは `AgeBand` /
  `TrainingAgeTier` という簡略表記だった（[R10-B3] 上記コードブロックを正確な型へ更新済み）。実際は次のとおり:
  - `ageBand: ResolvedAgeBand`（= `AgeBand | "UNKNOWN"`。`resolveSubjectProfile()` の出力型をそのまま再利用する。
    GROUP が空、または member の年齢帯を確定できない場合は `"UNKNOWN"`）。
  - `trainingAgeTier: TrainingAgeTier | "UNKNOWN"`（Provenance 専用の最小型 `ProvenanceTrainingAgeTier`。
    トレーニング歴が実際に入力されていれば解決済みの tier、`resolveSubjectProfile().trainingAgeKnown` が
    false のときは `"UNKNOWN"`）。
  - **core の `AgeBand` / `TrainingAgeTier` 自体には `"UNKNOWN"` を追加しない**（eligibility・range lookup 等の
    通常利用で `"UNKNOWN"` を実在の値として誤用させないため）。
  - Provenance は監査ログである。エンジンが安全側に倒すために内部で使う保守的な既定値（例: トレーニング歴
    不明のときの `BEGINNER` 扱い）と、実際に「入力が分かっていたか」は別の事実であり、Provenance は後者を
    正直に記録する（前者で上書きしない。§13.5 と同じ「エンジン内部の判断」と「入力状態の記録」の分離）。
- **[R10-B4A] `findingConfirmations?`（backward-compatible optional。schemaVersion=1 のまま）。** コーチが
  `confirmedFindingCodes` で明示確認した `REQUIRE_CONFIRMATION` の監査記録。**その保存時の plan 結果に実在した code だけ**を
  `{ code, at }` で記録し（client が送った任意の文字列は保存しない）、確認した Finding が無い保存では key 自体を持たない。
  edit / override / recalculate では**引き継がない**（毎回、現在の結果に対して記録し直す）。旧 provenance（key 無し）はそのまま読める。
- **[R10-B4A] `overrides[].confirmedTwice?`（backward-compatible optional）。** override Action でコーチが実際に送った
  `confirmedTwice` の値。再計画でこの override を `CoachOverride` として再構築するときは**この記録値をそのまま**使い、
  `true` へ自動昇格しない（記録の無い R10-B4A より前の履歴は `false` として domain schema に渡し、ELIGIBILITY /
  HARD_SAFETY なら再構築を拒否して例外設定のやり直しを求める）。
- **[R10-B1.1 errata] `competitionWindows` の意味。** 「その plan 呼び出しへ供給された、登録済み大会 context の
  安定した digest」を意味する。**「実際に大会近接ウィンドウの判定にマッチした大会だけ」を意味しない**
  （どの大会が実際にマッチしたかは `PlanResult` から公開されておらず、application 層が §14 の window 判定
  ロジックを再実装することもしない）。エンコードは `${id}:${priority}` を大会の登録順に並べたもので、
  決定的（同じ入力なら同じ digest）・個人情報や大会名を含まない・大会 window ポリシーの再構築には使わない。

---

## 17. Snapshot Integrity

### 17.1 不変条件（既存 + v2 追加）
1. `TrainingSession` / `SessionItem` は `MenuTemplate` / `MenuItem` を**参照しない。展開時にコピーする**（既存・変更禁止）。
2. `createSessionFromMenu()` は**ルールセットを読まない・`plan()` を呼ばない・値を再計算しない**。
   - **[R9 clarification]** RuleSet を必要とする domain policy（集計 §11・週次 §12）の評価も repository では行わない。
     評価は R10 の application layer の責務で、結果はデータとして渡す（§11.5）。v2 の loadCategory は処方 JSON の
     `loadSnapshot` から読む（RuleSet lookup をしない）。
3. `SessionItem` の planned 系列（既存 planned* と v2 追加列）は**作成後に更新しない**。更新してよいのは actual 系列だけ。
4. ルールセットの改版、MenuItem の編集、Exercise の編集・削除、レンダラ（日本語文言）の変更は、**既存 SessionItem の計画値・理由文を変えない**。
5. Stop policy と timing tolerance は plan 時に `prescriptionJson` に**埋め込む**。monitor はスナップショットの値で判定する（ルールセット改版後も当時の基準で判定）。
   - **[R4 errata]** 埋め込み先は `RunningPrescription.monitoringSnapshot`（`stopPolicy` = 選ばれた StopPolicy の行のコピー、
     `timingTolerances` = plan 時点の全 TimingMethod の行のコピー）。`stopPolicyId` は検索・表示用。RuleSet を後から変更しても
     既存処方の snapshot は変わらないことを R4 のテストで保証する（monitor 本体は R8）。
   - **[R8 errata]** snapshot に次を追加する: `stopPolicy.runtime`（§10.3 の実行時挙動の構造化 metadata。§10.6）と
     `safetyPolicy`（§13.2 の red flag グループと「痛みあり」の safetyOutcome を R5 readinessRules からコピーした
     versioned policy。選手の健康情報ではない）。monitor は RuleSet loader・manifest・production JSON を一切 import しない。
   - **[R8 errata]** `safetyPolicy` も `stopPolicy` / `timingTolerances` と同じ snapshot 不変条件に従う: RuleSet A で計画した処方は、
     RuleSet を B に変更（例: medical red flag のグループ変更）しても A の policy で monitor する。全選手共通の policy 定義であり
     §13.5 の保存禁止対象（選手本人の health observation）ではないため `plannedPrescriptionJson` に保存してよいが、選手の選択値・
     部位・尺度・報告者・rule id を含めてはならない（readinessRules の rule id もコピーしない。monitor に必要なのは RedFlag →
     SafetyOutcome のグループだけ）。
6. 理由文は plan 時に**レンダリング済みテキスト**で保存する（コードも保存するが、後から再レンダリングしない）。

### 17.2 コピー対応表（MenuItem → SessionItem）

| MenuItem | SessionItem | 備考 |
| --- | --- | --- |
| （既存）sets / reps / distanceMeters / durationSeconds / restSeconds / intensityPercent / loadKg / note | plannedSets / plannedReps / plannedDistanceMeters / plannedDurationSeconds / plannedRestSeconds / plannedIntensityPercent / plannedLoadKg / plannedNote | 既存のまま |
| （既存）exercise?.name ?? displayName / block.name | exerciseNameSnapshot / blockNameSnapshot | 既存のまま |
| prescriptionKind | prescriptionKind | 追加 |
| runningMethod / sessionTemplateId / recoveryStructure | 同名 | 追加 |
| buildUpDistanceMeters / flyZoneDistanceMeters | plannedBuildUpDistanceMeters / plannedFlyZoneDistanceMeters | 追加 |
| setRestSeconds / intraRepRestSeconds | plannedSetRestSeconds / plannedIntraRepRestSeconds | 追加 |
| intensityReferenceKind / prescriptionConfidence | plannedIntensityReferenceKind / plannedPrescriptionConfidence | 追加 |
| ruleSetVersion / ruleSetContentHash | 同名 | 追加 |
| prescriptionJson / provenanceJson / rationale | plannedPrescriptionJson / plannedProvenanceJson / plannedRationale | **文字列をそのままコピー**（パースして再直列化しない） |
| （Exercise.category → 対応表 §12.2、v2 は MethodMeta） | loadCategory | 追加（Exercise の名前と同じくコピー時点の値）。[R9] v2 は `prescriptionJson.loadSnapshot.weeklyLoadCategory`。壊れた JSON・loadSnapshot の無い旧 snapshot のときだけ null + `SNAPSHOT_LOAD_CATEGORY_UNRESOLVED`（REQUIRE_COACH_REVIEW） |

### 17.3 スナップショット時の検証 [ENGINE-POLICY]
- JSON 列はコピー後に `RunningPrescriptionSchema` の**全 schemaVersion 対応パーサ**で検証する。
- 検証に失敗しても**コピーは中止しない・値を書き換えない**。`planningSnapshotJson.findings` に `SNAPSHOT_JSON_INVALID`（REQUIRE_COACH_REVIEW）を記録する。
- 過去版の説明表示は SessionItem のスナップショットだけで行う。ルールセットファイルの Evidence 詳細を表示する場合は `version` と `contentHash` の一致を確認し、不一致なら「版情報不一致」と表示する。
- **[R9/R11-B6] `planningSnapshotJson` の形（schemaVersion 1）:** `{ schemaVersion, plannedDate, plannedAt, aggregation, weeklyContext, findings, competitionLoadCategory?, competitionLoadCategories? }`。
  - `competitionLoadCategory`は旧read compatibility専用。新writerはcanonicalな`competitionLoadCategories`だけを書く。両fieldの同時存在はinvalid。
    additive optional fieldのためschemaVersionは1のまま。
  - `aggregation` = `NOT_EVALUATED{ reasons }` | `EVALUATED{ ruleSet: { version, contentHash }, result: SessionAggregate }`
  - `weeklyContext` = `NOT_EVALUATED{ reasons }` | `EVALUATED{ ruleSet, items: [{ menuItemId, sortOrder, result: WeeklyContextResult }] }`
    （evaluateWeeklyContext は計画項目ごとの評価のため項目単位。sortOrder は repository が SessionItem に合わせて付ける）
  - `reasons`: `PLANNING_EVALUATION_NOT_SUPPLIED`（R9 の既定）/ `PLANNED_AT_UNAVAILABLE` / `MIXED_RULESET_VERSIONS` / `RULESET_VERSION_UNAVAILABLE`
  - `findings` = 渡された評価の findings → RuleSet 非依存のスナップショット検証（`SNAPSHOT_JSON_INVALID` 等）の順
  - repository は、`EVALUATED` の `ruleSet` がメニューの RUNNING_V2 項目の `ruleSetVersion` + `ruleSetContentHash` と一致しない評価、
    メニュー外 / legacy の menuItemId を参照する評価を保存しない（例外）。raw health report・RuleSet object・Evidence 全文は含めない。

### 17.4 維持するテスト（無改変で通すこと）
- `tests/repository/snapshot-integrity.test.ts`（9件）
- `scripts/verify-snapshot.ts`（7項目）
- 追加テストは §20 の SNAP 群。

---

## 18. AI Boundary

### 18.1 許可と禁止を型・API で実装する

| AI に | 内容 | 実装手段 |
| --- | --- | --- |
| 許可 | 目的の理解 | MenuPlanner port の入力（自然文） |
| 許可 | Method 候補・template の選択 | `AiRunningItemProposal.method / templateId` |
| 許可 | 既存 Exercise の選択 | 既存 MenuPlanner 設計（Mobile Menu Builder v1） |
| 許可 | Menu 構成・順序 | `blockName` と配列順 |
| 許可 | 理由説明 | `reason`（表示専用・サニタイズ §18.3） |
| 許可 | 範囲内の位置の希望 | `positionPreference: "LOWER" | "MIDDLE"` |
| 禁止 | 研究 range を無視した数値生成 | proposal に数値フィールドが**存在しない**（`.strict()` で余分なキーを拒否） |
| 禁止 | hard safety override | `applyCoachOverride()` の引数が `CoachActor` 型。AI 経路のモジュールは `createCoachActor` を import できない（eslint） |
| 禁止 | maturity override | subject はサーバーが `runningContextJson` から組み立てる。proposal に subject フィールドが無い |
| 禁止 | advanced-only Method の勝手な許可 | `allowAdvancedMethods` はコーチが設定する context 値。AI actor の場合、ASSISTED は常に INELIGIBLE、他の advancedOnly template は tier=ADVANCED かつ許可済みのときだけ適格 |
| 禁止 | coachEditableRange の拡張 | 拡張 API が存在しない（ルールセット改版のみ） |
| 禁止 | Evidence の捏造 | proposal に evidenceIds が無い。reason から出典らしき記述を除去 |
| 禁止 | ruleSetVersion の変更 | PlanRequest に版指定が無い（サーバーが決める） |
| 禁止 | コーチ手入力の強度基準（目標スプリット等）の生成 | [R10-B4A.2] `PlanRequest.coachReference` は COACH actor だけが持てる（AI / SYSTEM は schema が拒否）。proposal schema に数値 field を追加しない |
| 禁止 | Coach 専用 Action の流用（CoachActor 権限の間接利用） | [R10-B4A.1] AI モジュールは `src/actions/running-actions.ts`・`_running-plan-service.ts`・`_actor.ts` を**モジュールごと** import できない（alias / 相対パス / 拡張子付き / re-export / 型 import を eslint で拒否。dynamic import はソース監査） |

### 18.2 型

```ts
export type MenuPlannerIntentRequest = {
  schemaVersion: 1;
  requestText: string; // trim 後 1..2000
  constraints: {
    phase: TrainingPhase | null;
    targetEvents: TrackFieldEvent[];       // max 8
    purposes: ExercisePurposeValue[];      // max 16
    availableMinutes: number | null;       // integer 1..600、coerce しない
    equipment: { availableTagIds: string[] } | null; // max 30
    preferredExerciseIds: string[];        // max 20
    excludedExerciseIds: string[];         // max 20
  };
};

export type ExerciseCandidateDto = {
  id: string;
  name: string;
  category: ExerciseCategory;
  purposes: ExercisePurposeValue[];
  events: TrackFieldEvent[];
  equipmentTagIds: string[];
};
export type EquipmentCandidateDto = { id: string; name: string };
export type RunningTemplateCandidateDto = {
  method: RunningTrainingMethod;
  templateId: string;
  label: string;
};

export type MenuPlannerProviderRequest = {
  schemaVersion: 1;
  policy: { id: "R12_MENU_INTENT_V1" };
  coachRequest: MenuPlannerIntentRequest;
  subject: AiSafeSubjectContext;
  catalog: {
    exercises: ExerciseCandidateDto[];
    runningTemplates: RunningTemplateCandidateDto[];
    equipment: EquipmentCandidateDto[];
  };
};

export interface MenuIntentParser {
  propose(
    request: MenuPlannerProviderRequest,
    options?: { signal?: AbortSignal },
  ): Promise<MenuIntentParserResult>;
}
export type MenuIntentParserResult =
  | { ok: true; output: unknown }
  | { ok: false; kind: "UNAVAILABLE" | "FAILED" | "TIMEOUT" | "ABORTED" | "OUTPUT_TOO_LARGE" };

export type AiPlannerItemProposal =
  | { kind: "RUNNING"; proposal: {
      blockName: string;
      method: RunningTrainingMethod;
      templateId: string;
      positionPreference: "LOWER" | "MIDDLE" | null;
      reason: string;
    } }
  | { kind: "EXERCISE"; proposal: {
      blockName: string;
      exerciseId: string;
      reason: string;
    } };

export type AiPlannerProposal = {
  schemaVersion: 1;
  items: AiPlannerItemProposal[];
  question: {
    missingField: "PURPOSE" | "EVENT" | "EQUIPMENT" | "EXERCISE_PREFERENCE" | "REQUEST_DETAIL";
    text: string;
    options: string[];
  } | null;
};
```

- 実装場所は video 用 `src/domain/ai/**` と分離した `src/domain/menu-planner/**`。domain/application contract → 将来の infra adapter → 将来の server composition の一方向依存とする。
- `MenuIntentParser` 成功値の `output` は必ず `unknown`。provider の structured-output 検証を信頼境界にせず、application が `aiPlannerProposalSchema` で再検証する。
- 全 object schema は `.strict()`。unknown key・unknown enum・型 coercion・invalid item の drop・dedupe・fallback を禁止し、proposal 単位で拒否する。
- request の ID は trim 後 1..64。各配列の重複と preferred / excluded の積集合を拒否する。canonical 化は enum 宣言順、opaque ID は昇順とし、proposal の `items` 順は変更しない。
- `AiPlannerProposal` は `question === null` なら `items` 1..20、`question !== null` なら `items.length === 0`。AI は question ID を返さず、必要な identity は application が将来生成する。
- clarification の text は trim 後 1..200、options は0件または2..4件、各 trim 後 1..80、重複禁止。中間状態・raw prompt・raw response はDBに保存せず、reloadで失うephemeral stateとする。
- `blockName` は NFKC・trim・空白正規化後 1..80。control / bidi・HTML / markup・URL を拒否する。閉じた blockName の再登場と9 block以上を拒否する。同一block内のRUNNING / EXERCISE混在と配列順の採用は許可する。
- 同一 Exercise ID、同一 method + templateId の重複は拒否する。schema parse 後にserver catalogに対する別のpure validationを行い、unknown Exercise、unknown template、template-method mismatchをproposal単位で拒否する。
- AI-safe catalog に Exercise の数値既定・description・coach memo・video text・ownerId・Prisma rowを含めない。owner scopeとarchived除外はcatalog構築側の責務。running catalogにRuleSet数値・Evidence・safety値を含めない。
- subject は §13.5 の `AiSafeSubjectContext` の6 fieldだけを再利用し、birthDate / sexForNorms / maturity detail / raw readiness / pain / soreness / fatigue / sleepを追加しない。
- provider decoded UTF-8 output上限は64 KiB。timeoutはbounded config必須だが秒数はprovider評価フェーズで決める。failure resultにraw error message / stack / endpoint / response bodyを含めない。

### 18.3 reason のサニタイズ [ENGINE-POLICY]
- strict proposal parse と raw 300-character check を先に行い、その後だけ `reason` を NFKC・trim・文分割する。proposal 全体を sanitizer で救済してはならない。
- 除去（該当文を丸ごと削除し Finding `AI_REASON_SANITIZED` INFO）:
  - 数値用量（distance / reps / sets / duration / rest / intensity / pace / velocity / volume / recovery 相当）
  - HTML tag、Markdown link、URL、code fence / inline code
  - control / bidi character
  - system / developer / assistant の role impersonation、以前の指示を無視する要求、system prompt override
  - 出典らしき表現、技術による中止指示など AI reason の表示責務を超える文
- 残った文は空白1個で結合し、single-line plain text とする。sanitization の有無を pure result で返し、raw text や chain-of-thought は保存しない。
- 表示上は「AIの理由」と「エンジンの根拠」を別ラベルで並べる。

### 18.4 自動生成制限の適用範囲
- `BLOCK_AUTOGEN` Finding は **actor が AI_PLANNER / SYSTEM のときに適用**（その項目を生成しない）。コーチの手動選択では表示のみ（eligibility と override 規則は別途適用）。
- AI 由来の項目は accept/save の deterministic rebuild まで `actor = AI_PLANNER` とし、`overrides = []`、`coachEdits = []`、`coachReference = null`、`confirmedFindingCodes = []` を固定する。AI proposal の確認操作だけで COACH actor へ昇格させない。
- メニューは explicit accept 後も `status = "DRAFT"`。新しい `acceptedByCoachAt` DB field は追加せず、AI proposer は既存 strict provenance に保存する。AI reason と engine rationale は混ぜない。保存後に既存 manual authoring で編集する処理だけが通常の COACH authority を使う。

### 18.5 [R10-B4A.1] Coach 専用 application module の AI 境界

- **AI モジュール**（`src/domain/ai/**`・`src/domain/menu-planner/**`・`src/infra/ai/**`・`src/app/ai/**`・`src/actions/ai/**`・`src/actions/ai-*`・`src/actions/_ai-*`）は、
  次を import できない（`eslint.config.mjs` の AI ブロック。alias だけでなく相対パス・拡張子付きの迂回も patterns の regex で拒否）:
  - `src/actions/_actor.ts`（`getCoachActorForServer`。CoachActor 生成の唯一の server boundary）
  - `createCoachActor` / `coachActorSchema` / `CoachActor` 型（`@/domain/running/types/actor` と root re-export `@/domain/running`。相対パスも）
  - **`src/actions/running-actions.ts` のモジュール全体**（`planRunningItemAction` / `editRunningItemAction` / `overrideRunningItemAction` /
    `recalculateWithActiveRuleSetAction` / `updateRunningMenuContextAction` と、将来この module に追加される export すべて）
  - `src/actions/_running-plan-service.ts`（内部で CoachActor を生成する Coach 専用 service）
- 理由: `running-actions.ts` は CoachActor・coachEdits・overrides・`confirmedTwice`・`confirmedFindingCodes`・`allowAdvancedMethods`
  （`updateRunningMenuContextAction`）を扱う **Coach の信頼境界**であり、AI がこれを呼べると Coach 専用の権限を間接的に使えてしまう。
  関数名の denylist ではなく module import 自体を禁止し、将来の export 追加で穴が開かないようにする。
- `src/actions/**` 全体は禁止しない。CoachActor を扱わない安全な port（例: `_running-template-options.ts` の template 候補 provider）や、
  R12 で作る AI actor 専用の application path は AI から使ってよい。Coach 側（Menu UI → `running-actions`）の import は制限しない。
- **[R12 formal requirement] AI の Running 処方生成は Coach Action を再利用しない。** 経路は
  `provider output unknown → aiPlannerProposalSchema（.strict()）→ reason sanitizer → catalog validation → AI actor 専用 application path（actor = AiPlannerActor）→ domain planner`
  とし、`running-actions.ts` / `_running-plan-service.ts` へショートカットしない。R10-B4A.1 ではこの経路を作らない。
- **proposal の全階層を `.strict()` のまま**にし、distance / reps / sets / duration / rest / setRest / intensity / percentage / pace / velocity / volume / recovery / stopPolicy / safety / readiness / monitor / ruleSetVersion / evidenceIds / overrides / coachEdits / coachReference / confirmedFindingCodes を追加しない。

### 18.6 Preview / accept / stale contract [R12-A1]

- validated proposal はserverがdeterministic plannerを実行してwrite-0 `MenuPlannerPreview` にする。previewとclarification stateはDBに保存しない。raw RuleSet / provenance JSON / health inputをclientへ返さない。
- preview はblocks、ordered items、deterministic running prescriptionの表示DTO、non-running deterministic defaults、sanitized AI reason、engine findings / warnings、estimated time（算出可能な場合）だけを持つ。AI数値をpreview fieldにmaterializeしない。
- clientが返すpreview数値・provider/model・actor・RuleSet identity・provenanceは保存authorityではない。acceptはserver-issued opaque bindingとproposal selection identityと許可された構造編集だけを受け取る。
- accept時はowner-scoped Exercise / Running template catalog、RuleSet identity、AI-safe subject、history、competition/menu context、planning dateをserverが再読込し、proposal strict parse・catalog validation・deterministic planningを再実行する。
- preview時のcanonical display result / authoritative context bindingとaccept時結果が一致しなければ `STALE_PREVIEW` で全体を拒否する。silent recalculationでコーチが見ていない別メニューを保存しない。UIは新しいpreviewの生成を要求する。
- preview bindingのHMAC / digest / revision tokenの具体実装はapplication phase。DB無しでtamperとstaleを検出できるserver-issued bindingを必須とする。

### 18.7 AI → deterministic planner mapping [R12-A1]

- RUNNING itemでAIが供給できるのはcatalog-bound `method` / `templateId`、`positionPreference`、block/order、sanitized reasonだけ。
- serverはplanningDate、subject、menuContext、history、readiness、competition context、RuleSet loader、`actor = AI_PLANNER`を供給する。事前メニュー作成のreadinessは`null`。AIにreadiness / medical judgmentをさせない。
- non-running itemでAIが供給できるのはowner-scoped existing Exercise ID、block/order、sanitized reasonだけ。数値はexisting Exercise defaults → deterministic non-running prescriptionで決める。必要なdefaultが無ければitemを拒否してmanual input / clarificationを要求し、AIで補完しない。
- `availableMinutes` はselection constraintに使えるが、時間へ合わせてAIが数値処方を変更してはならない。deterministic resultが超過した場合はfinding / re-proposalとし、silent scalingを禁止する。

### 18.8 Atomic save / privacy [R12-A1]

- explicit acceptの成功時だけ、`MenuTemplate(status = DRAFT)`、全`MenuBlock`、全`MenuItem`、running prescription / provenanceを同一transactionで作る。失敗時はpartial template / block / itemを0件にrollbackする。
- raw coach prompt、raw provider response、chain-of-thought、clarification途中状態、previewはDBへ保存しない。server logにもraw prompt / raw response / provider bodyを出さない。
- requestId、provider、modelはserver-generated provenanceでありclient inputを信頼しない。free-form AI reasoningをprovenance JSONへ入れない。

### 18.9 Feature / production gate [R12-A1]

- feature flagは`AI_MENU_PLANNER_ENABLED`、default OFF。将来のUIとServer Actionの双方がOFF時に拒否する。Running proposalはさらに`RUNNING_V2_UI_ENABLED`が必要。
- flag OFFでのcontract/application実装・testは許可する。production enableは **OPEN-20完了 AND ACTIVE RuleSet AND `AI_MENU_PLANNER_ENABLED`** を必須とする。OPEN-20とDRAFT RuleSetはimplementation blockerではなくproduction gateである。
- video ingestion / YouTube / Exercise video analysis / Antigravity analyzerはR12 MenuPlannerに含めず、`src/domain/ai/**`の`VideoAnalyzer` / `ExerciseDraft` / `AnalysisJob` / `rawOutput` contractをimportしない。MenuPlanner routeはvideo専用`/ai`を再利用せず、将来`/menus/new/ai`とする。

---

## 19. Validation

### 19.1 Zod スキーマ一覧

| スキーマ | 使う場所 | 主な refine |
| --- | --- | --- |
| `RuleSetSchema` | loader・テスト | 全 template の method 実在／id 名前空間の非重複／Envelope の evidenceIds が usage=PRESCRIPTION／recommended ⊆ coachEditable ⊆ hardSafety（null は無制限）／CONTEXT_ONLY の参照禁止 |
| `PlanRequestSchema` | `planRunningItemAction` | method↔template 整合／actor=AI のとき overrides・coachEdits が空 |
| `RunningPrescriptionSchema`（schemaVersion 別） | plan 出力・保存前・スナップショット検証 | recoveryStructure は LONG のとき必須・他は null／FlyRep の total = build + fly + decel／sets と repsPerSet が非 null／value ∈ coachEditable（または対応する override あり）／intensity reference kind が MethodMeta で許可 |
| `ProvenanceSchema` | 保存前 | 健康情報キーの不在 |
| `RunningMenuContextSchema` | MenuTemplate 保存前 | `.strict()`。pain/soreness/sleep/sex/birthDate の詳細を持てない |
| `ReadinessReportSchema` | 当日入力（保存しない） | 選択式のみ |
| `RepObservationSchema` | monitor 入力 | `.strict()`。index は 1 始まり整数、timeS / fps / 速度は finite > 0、restTakenS ≥ 0、vdec 0–100、実測露出は `source: "MEASURED"`・finite ≥ 0・lower ≤ upper。**[R8 errata] timing=VIDEO で fps が無くても拒否しない**（§20 T-TIM-05 を採用。正規化で UNKNOWN 扱い → COACH_ONLY） |
| `CoachOverrideSchema` | override Action | reason ≥ 10文字、HARD_SAFETY/ELIGIBILITY は confirmedTwice=true |
| `CompetitionInputSchema` | 大会登録 | priority enum、date 必須 |
| `menuPlannerIntentRequestSchema` | MenuPlanner coach request | 全object `.strict()`、文字数・配列上限、重複、preferred/excluded交差を拒否 |
| `menuPlannerProviderRequestSchema` | providerへ渡すsafe envelope | policy literal、AI-safe subject、数値既定/free text/owner rowを持たないcatalog |
| `aiPlannerProposalSchema` | providerのunknown outputをapplicationが受け取る境界 | schemaVersion=1、全階層`.strict()`、question/items排他、numeric authority field拒否、ordered mixed items |
| catalog-bound validation | strict parse後 | Exercise ID実在、template実在、method一致。invalid itemのdrop/fallback禁止 |

### 19.2 永続化時の整合規則
- `prescriptionKind = "RUNNING_V2"` ⇒ `exerciseId = null`、`runningMethod`・`sessionTemplateId`・`ruleSetVersion`・`ruleSetContentHash`・`prescriptionJson`・`provenanceJson`・`rationale` が非 null、`sets`・`reps` が非 null。
- JSON サイズ上限: prescriptionJson ≤ 32KB、provenanceJson ≤ 16KB、actualRepLogJson ≤ 64KB。[ENGINE-POLICY]
- SQLite に CHECK 制約は入れない（既存方針）。整合はアプリ層で保証する。

---

## 20. Test Matrix

- すべて Vitest（既存構成・`fileParallelism: false`）。**新規パッケージは追加しない**。property / boundary テストは fast-check を使わず、**列挙型の全組み合わせ × 境界値の決定的グリッド**で行う。[ENGINE-POLICY]
- 置き場所: `tests/domain/running/**`（純粋関数）、`tests/domain/menu-planner-contracts.test.ts`（R12 MenuPlanner pure contract）、`tests/repository/running/**`（DB）、`tests/actions/running/**`（Server Action、既存の `revalidatePath`/`redirect` モック規約に従う）。
- ルールセットはテスト用に `rs-test.json`（本番版のコピー + テスト専用版）を loader 差し替えで使い、**本番版の数値変更でテストの意味が変わらない**ようにする。ただし T-RV 群と T-POP 群の一部は本番の DRAFT 版に対して実行する。

### 20.1 カテゴリ別

| 群 | 目的 | 主なテスト | フェーズ |
| --- | --- | --- | --- |
| **UNIT** | 各関数の単独挙動 | deriveDirectness の全分岐、position→値の丸め、区間演算（null 伝播）、ageBand 境界（11/12/14/15/17/18歳の誕生日前後） | R1–R8 |
| **PROPERTY / BOUNDARY** | 全組み合わせで不変条件 | 全 Method × 全 template × tier × maturity × trainingAge × phase のグリッドで: ①value ∈ recommended（override なし時）②rest の position ≥ MIDDLE ③hardSafety を超えない ④LONG 以外は recoveryStructure=null ⑤MAX_INTENT なら intensityPercent=null ⑥sets/repsPerSet 非 null | R4 |
| **POPULATION** | 人口別の分岐 | §20.2 T-POP | R3–R4 |
| **SNAPSHOT** | スナップショット不変条件 | 既存 9件 + T-SNAP | R9 |
| **AGGREGATION** | メニュー全体の判定 | T-AGG | R6 |
| **PLAUSIBILITY** | 入力ミス・単位破綻 | T-PLA | R6 |
| **MISSING-DATA** | データ欠損時の保守化 | T-MISS | R3–R4 |
| **TIMING-METHOD** | 計時法と stop | T-TIM | R8 |
| **AI BOUNDARY** | AI の越権防止 | T-AI | R11 |
| **RULE-VERSION** | 版の不変性と追跡 | T-RV | R2・R9 |
| **LEGACY GOLDEN** | 旧エンジンの凍結 | 12 Kind × 4 レベル × 5 期分け × 代表既定値パターンの出力を JSON fixture で固定 | R0 |

### 20.2 必須ケース（Given / When / Then）

| ID | 必須ケース | Given | Then |
| --- | --- | --- | --- |
| T-POP-01 | **maturity UNKNOWN** | U15、maturity=UNKNOWN、trainingAge 3年 | tier=DEVELOPMENTAL。LONG（全）・ASSISTED・RS HEAVY は INELIGIBLE。ACC ≤20m・STRIDE・MV_FLY10（reps≤3）は自動生成可。SES は手動+REVIEW（**PRE とは違い不適格にならない**） |
| T-POP-02 | **youth** | U12、maturity=PRE | U12 制約で LONG/ASSISTED/TI/RS HEAVY が override 不可。自動生成は complexity LOW のみ |
| T-POP-03 | growth velocity CHECK_ONLY | U15、申告 POST、成長速度 8cm/年 | `rapidGrowthFlag=true` を監査情報として保持するが、maturity category / eligibility / tier を自動変更しない |
| T-POP-04 | **trainingAge beginner** | U18、POST（MEDIUM）、年数 0.5 | tier=DEVELOPMENTAL。ACC の envelope が DEV 値 |
| T-POP-05 | **adult beginner** | ADULT、年数 null | trainingAge=BEGINNER → tier=DEVELOPMENTAL（POST でも ADVANCED にならない） |
| T-POP-06 | **elite** | ADULT、coachAssignedTier=ADVANCED、PHOTO_CELL fly 記録あり | tier=ADVANCED、MV envelope が ADV 値、prescriptionConfidence ≤ MODERATE（SECONDARY_REPORT_ONLY のため） |
| T-POP-07 | **ASSISTED が youth に出ない** | U18 POST ADVANCED 以外の全組み合わせ、actor=AI | ASSISTED は常に INELIGIBLE。U12/U15 と PRE/CIRCA/UNKNOWN は coach override でも不可 |
| T-MISS-01 | **100m PB のみ** | ATHLETE、100m PB（HAND）だけ | MV は MAX_INTENT（LOW）、TE は RELAXED_SUBMAX で数値目標なし（LOW → LOWER_HALF + REVIEW）、LONG は INELIGIBLE、**Vmax 推定値を生成しない** |
| T-MISS-02 | **Vmax なし** | vmax=null、fly 記録なし | MV の露出は FLY_ZONE 区間（ESTIMATED）、intensity target=null、confidence LOW |
| T-MISS-03 | **fly measured** | FLY20 PHOTO_CELL 2.00秒、45日前 | vmax=10.0 m/s、区間 [20/2.05, 20/1.95]、TE 目標タイムが区間で出る |
| T-MISS-04 | 履歴なし | history=null | HISTORY_UNKNOWN、confidence LOW、HIGH_METABOLIC は REVIEW |
| T-MISS-05 | 古い PB | U15 の PB が 200日前 | inputData confidence が1段下がる |
| T-TIM-01 | **hand timing** | SP_ACC、30m HAND、ベスト 4.50 | 4.70 → PASS（tol 0.25）、4.80 → FAIL。2回連続 FAIL → END_SESSION_QUALITY |
| T-TIM-02 | HAND の fly10 | MV_FLY10、HAND、1.10秒 | tol/参照 > 0.10 → NOT_EVALUATED_COACH_ONLY |
| T-TIM-03 | **fly measured** | MV_FLY20、PHOTO_CELL | 数値判定あり（tol 0.05） |
| T-TIM-04 | UNKNOWN / RADAR | timing=UNKNOWN、RADAR_LASER | COACH_ONLY |
| T-TIM-05 | VIDEO fps なし | timing=VIDEO、fps 未入力 | UNKNOWN 扱い → COACH_ONLY |
| T-TIM-06 | 痛みが計時より優先 | timeS=null、painNow=true | STOP_SAFETY |
| T-WK-01 | **race yesterday** | 24h 前に RACE（COMPETITION セッション） | 計画 MV → BLOCK_AUTOGEN + REVIEW（WEEKLY_HIGH_WITHIN_48H）。STRIDE は許可 |
| T-WK-02 | **heavy plyometrics yesterday** | 24h 前に PLYOMETRIC（HIGH） | ACC → WEEKLY_NONRUN_HIGH_WITHIN_48H で BLOCK_AUTOGEN |
| T-WK-03 | legacy の UNKNOWN 強度 | 30h 前に legacy JUMP 種目 | readiness 必須。未入力なら USE_LOWER_BOUND |
| T-WK-04 | 48–72h | 60h 前に MV | READINESS_CHECK_REQUIRED |
| T-WK-05 | Method 別時間差を持たない | 前回 SES / 前回 ACC の各 50h 後 | 同一判定（どちらも 48h 経過扱い） |
| T-AGG-01 | 加速3項目 | DEV で ACC 各 120m × 3項目 | AGG_METHOD_BUDGET_OVER_*（監査 H-5 の再発防止。§11.6-4） |
| T-AGG-02 | null を 0 にしない | 露出 upper=null の項目を含む | completeness=PARTIAL、比較不能 Finding |
| T-AGG-03 | **MAXV + acceleration 同日** | ADV: ACC 150m + MV fly 90m | 高強度予算 0.5 + 0.6 = 1.1 → AGG_HIGH_INTENSITY_BUDGET（WARN） |
| T-AGG-04 | legacy の sets/reps 曖昧 | legacy SPRINT 60m, sets 4, reps null | 総走行距離 [240, 240]。reps 5 なら [240, 1200] |
| T-STR-01 | **STRIDE** | 流し 100m × 4 | intensity=RELAXED_SUBMAX、intensityPercent=null、露出 0（RULE_DEFINITION）、48h ロックなし |
| T-STR-02 | STRIDE に TE 量を使わない | STRIDE の envelope | sessionVolumeM.recommended.max ≤ 480、TE の 1000–2000 を参照しない |
| T-STR-03 | 「流し7〜8割 → 加速95%」の再発防止 | v2 で STRIDE を選択 | Method が ACCELERATION にならない。MAX_INTENT にならない |
| T-LSR-01 | **LONG FULL** | ADULT ADVANCED 400m、LSR_SPECIAL_ENDURANCE_I | recoveryStructure=FULL、stopPolicy=SP_LSR_FULL（2回連続超過で終了） |
| T-LSR-02 | **LONG INCOMPLETE（POST+ADVANCED）** | 同上、LSR_300_PLUS_100 | SP_LSR_INCOMPLETE_ADV、分割走内の低下では END しない、hard stop は有効 |
| T-LSR-03 | LONG INCOMPLETE（それ以外） | U18 POST DEVELOPING 400m | 自動生成されない。override で手動処方しても stopPolicy=SP_LSR_INCOMPLETE_STRICT |
| T-LSR-04 | recoveryStructure 必須 | LONG で recoveryStructure 欠落 | Zod で拒否 |
| T-PLA-01 | **80km accident** | TI_COACH_DEFINED で distance 5000 × reps 8 × sets 2 をコーチ入力（§11.6-15） | 項目 BLOCK（>10000m）、Session BLOCK（>30000m）、override 不可 |
| T-PLA-02 | sets/reps 取り違え | ACC totalReps = recommended.max × 3 | REQUIRE_CONFIRMATION |
| T-PLA-03 | 入力の桁ミス | 100m PB = 1.08 秒 | 入力 BLOCK |
| T-PLA-04 | legacy 警告フック | legacy suggestPrescription でペース走 5000m | 数値は golden と同一、Finding（plausibility）が追加される |
| T-EV-01 | directness の runtime 導出 | 同じ Haugen elite Evidence を ADULT ADVANCED と U12 PRE に適用 | PARTIAL/DIRECT と INDIRECT |
| T-EV-02 | LOW confidence の挙動 | confidence=LOW | 数値が LOWER_HALF 以下、HIGH_METABOLIC 自動生成不可、REVIEW |
| T-EV-03 | **Moran 16×20 が自動処方されない** | 全グリッド（U12–ADULT × 全 maturity） | ACC の totalReps が 16 にならない／Envelope が EV_MORAN_2016_YOUTH_DOSE を参照していない（RuleSetSchema が拒否） |
| T-SNAP-01 | v2 列のコピー | v2 項目からセッション作成 | 全列が一致、JSON は文字列同一 |
| T-SNAP-02 | MenuItem 編集の非波及 | 作成後に MenuItem の prescriptionJson を変更 | SessionItem は不変 |
| T-SNAP-03 | **old ruleSetVersion の session snapshot が変わらない** | rs-test-A で計画→セッション作成→ rs-test-B を ACTIVE 化→「現行ルールで再計算」 | MenuItem は B に更新、SessionItem の planned 列・rationale・stopPolicy は A のまま。monitor も A の tolerance で判定 |
| T-SNAP-04 | 壊れた JSON でもコピーは止めない | prescriptionJson を不正化 | コピー成功・値不変、SNAPSHOT_JSON_INVALID 記録 |
| T-SNAP-05 | createSessionFromMenu がルールを読まない | loader をスパイ | 呼ばれない |
| T-AI-01 | 数値フィールドの拒否 | proposal に `sets: 5` | Zod `.strict()` で拒否 |
| T-AI-02 | override 不可 | AI 経路から override を渡す | 型エラー（`@ts-expect-error` テスト）+ 実行時拒否 |
| T-AI-03 | ruleSetVersion 指定不可 | proposal に ruleSetVersion | 拒否 |
| T-AI-04 | advancedOnly | AI が TI_VITTORI_SE を DEV に提案 | INELIGIBLE |
| T-AI-05 | reason サニタイズ | reason に「30mを5本」「Haugen et al.」「フォームが崩れたら中止」 | 各文が除去、AI_REASON_SANITIZED |
| T-AI-06 | 健康情報の非送出 | AiSafeSubjectContext を JSON 化 | 禁止キーを含まない |
| T-AI-07 | BLOCK_AUTOGEN は AI にだけ効く | 48h 内 RACE、actor=COACH で MV を手動選択 | 処方は作られ Finding が付く |
| T-RV-01 | 版ファイルの不変 | ACTIVE 版 JSON を1文字変更 | manifest hash 不一致でテスト失敗 |
| T-RV-02 | provenance 保存 | plan → 保存 | ruleSetVersion・contentHash・evidenceIds が provenance と列に一致 |
| T-RV-03 | active 版の選択 | validFrom の異なる2版 | plannedDate に応じて正しい版 |
| T-RV-04 | 旧版の保持 | RETIRED 版 | 読み込み可能・新規 plan には使われない |
| T-SAFE-01 | pain red flag | U15、red flag=LIMPING | STOP + MEDICAL_EVALUATION_RECOMMENDED、override 不可 |
| T-SAFE-02 | 痛み未確認の youth | U15、pain=NOT_ASKED、MV 計画 | PAIN_CHECK_REQUIRED、自動生成されない |
| T-SAFE-03 | 痛みなし ≠ 許可 | pain=NONE_REPORTED、performance=DOWN | SWAP_TO_LOWER_LOAD_METHOD |
| T-SAFE-04 | readiness を割合にしない | fatigue=4 | 出力に割合・係数が無く、USE_LOWER_BOUND + INCREASE_REST |
| T-PH-01 | phase は hard stop を緩めない | 全 phase で painNow | すべて STOP_SAFETY |
| T-PH-02 | 記録会に 14日 taper を適用しない | TRAINING_MEET の 10日前 | 制限なし |
| T-PH-03 | youth に % taper を適用しない | DEV × PEAK の 10日前 | 位置は phase 規則のまま、% ガイダンスなし |
| T-PH-04 | ADVANCED × PEAK | 10日前、履歴4週分あり | 41–60% ガイダンス（applicabilityNotes 付き）、量 LOWER_HALF、強度参照不変 |

---

## 21. Migration Strategy

### 21.1 方針 [ENGINE-POLICY]
- **追加のみ（additive）**。既存列の変更・削除・型変更をしない。新列はすべて nullable または定数 default。
- 既存行は default により `prescriptionKind = "LEGACY"`、`sessionKind = "TRAINING"` になる。データの backfill はしない（現 dev.db の MenuItem / SessionItem は0件）。
- migration は **R9 で1本だけ**: `add_running_v2_prescription`。R0〜R8 は schema を触らない。

### 21.2 R9 での手順（実装時。今回は実行しない）
1. ユーザー承認を得る（schema 変更と dev.db の再定義を伴うため）。
2. `prisma/dev.db` をバックアップ（例: `prisma/dev.db.pre-r9.bak`）。**`npm run db:seed` / `db:reset` / `setup` は実行しない**（監査 C-1: 158種目が消える）。
3. `npx prisma migrate dev --name add_running_v2_prescription --create-only` で SQL を生成し、内容をレビュー。
   - SQLite では `TrainingSession` に外部キー（competitionId）を足すため **RedefineTables（新テーブル作成→コピー→差し替え）** が生成される。`INSERT INTO new_... SELECT` に全既存列が含まれることを確認。
4. 適用後、件数照合: Exercise 158 / VideoAsset 190 / ExerciseDraft 160 / Tag 364 / MenuTemplate・MenuItem・TrainingSession・SessionItem（適用前と同数）。
5. `npm run verify` と `npm run build`、`npx tsx scripts/verify-snapshot.ts` を通す。
6. `prisma/test.db` は既存の `db push` で自動追従。

### 21.3 Rollback
- migration 適用直後（v2 データ未作成）: バックアップの dev.db を戻し、migration フォルダを削除、コードを戻す。
- v2 データ作成後: **forward-only**。列は nullable のため、コードを戻すだけで旧画面は動く（新列は無視される）。列削除の migration は作らない。
- UI は環境変数 `RUNNING_V2_UI_ENABLED`（サーバー側で読む）で表示を切り替え、問題時は非表示にする。[ENGINE-POLICY]

### 21.4 PostgreSQL 移行時
- JSON を格納する `String` 列 → `Json`、列挙 `String` → enum。Zod スキーマは変更不要。

### 21.5 [R9 clarification] additive-only と SQLite の RedefineTables
- §21.1 の「追加のみ（additive）」は**論理スキーマの不変条件**（既存列の変更・削除・型変更をしない）であり、生成される SQL の形を制限するものではない。
- SQLite / Prisma は、NOT NULL + default の列や外部キーを追加するときに RedefineTables（新テーブル作成 → 全行コピー → 差し替え）を生成する。これ自体は禁止しない。代わりに、既存の列・外部キー・index が欠落なくコピーされることを SQL レビューと適用後の監査（列定義・FK・index・`PRAGMA foreign_key_check`・件数照合）で保証する。
- R9 の migration `add_running_v2_prescription` では `MenuItem`（prescriptionKind の default 付き NOT NULL）・`SessionItem`（同）・`TrainingSession`（sessionKind と competitionId の FK）が redefine された。

---

## 22. Implementation Phases R0–R13

- 1フェーズ = Sonnet 5 が1セッションで実装・検証できる大きさ。**前のフェーズの完了条件を満たすまで次に進まない。**
- 全フェーズ共通の完了条件: `npm run typecheck` / `npm run lint` / `npm test` / `npx tsx scripts/verify-snapshot.ts` / `npm run build` がすべて成功。既存テスト（166件）と `tests/repository/snapshot-integrity.test.ts` を**無改変で**通す（R13 の legacy golden 更新だけが例外）。
- 当初案（R0–R9）からの変更: planning core から readiness を分離（R5）、集計と週次を分離（R6/R7）、UI を2分割（R10/R11）、AI 統合を R12、**係数削除を独立した R13** にした（Fable C-1 の順序条件を明示するため）。

### R0 — 安全な準備・現行ルール凍結

| 項目 | 内容 |
| --- | --- |
| 目的 | 変更前の安全網。legacy の現挙動を固定し、以後の差分を検出できるようにする |
| 変更ファイル | `CLAUDE.md`（Running v2 の不変条件・禁止事項・本書へのリンクを追記）、`.gitignore`（`public/uploads/` `videos/` `tmp/` `scratch/` `/video_*.*` を追加 ※ユーザー承認後） |
| 新規ファイル | `tests/domain/prescription-legacy-golden.test.ts`、`tests/fixtures/prescription-legacy-golden.json`（数値・kind・rationale）、`tests/fixtures/prescription-legacy-warnings.json`（warnings は別 fixture にし、R6 で意図的に更新できるようにする）（本書は `docs/RUNNING_PRESCRIPTION_ENGINE_V2_SPEC.md` として保存済み） |
| git | 未追跡の `src/domain/prescription/` と `tests/domain/prescription-rules.test.ts` をコミット（ユーザー承認後） |
| schema / migration | なし / 不要 |
| domain type / validation | なし |
| tests | LEGACY GOLDEN（12 Kind × 4 レベル × 5 期分け × 既定値パターン4種） |
| 既存互換 | 挙動変更ゼロ |
| 完了条件 | golden fixture がコミットされ、legacy のコードを1文字変えると golden が落ちることを確認 |
| rollback | 追加したテストと fixture を削除 |

### R1 — domain types / Evidence model

| 項目 | 内容 |
| --- | --- |
| 目的 | §2 の型と Zod、§5 の Evidence・directness・confidence を純粋関数で作る |
| 変更ファイル | `eslint.config.mjs`（`src/domain/running/**` に `no-restricted-imports`） |
| 新規ファイル | `src/domain/running/types/*.ts`（§1.4）、`src/domain/running/evidence/{schema,directness,confidence}.ts`、`src/domain/running/index.ts`、`tests/domain/running/types.test.ts`、`tests/domain/running/evidence.test.ts` |
| schema / migration | なし / 不要 |
| domain type | Range / SoftRange / QuantityInterval / IntensityReference / RunningSelection / TemplateIdByMethod / FieldValue / RunningPrescription / Finding / EvidenceRecord / Actor |
| validation | 各型の Zod スキーマ（§19.1 のうち型レベルのもの） |
| tests | UNIT（deriveDirectness 全分岐・§5.4 表の全行）、型テスト（`expectTypeOf`、不正な method×template を `@ts-expect-error` で確認）、T-EV-01 |
| 既存互換 | 既存コードから import されない |
| 完了条件 | `index.ts` から公開 API 以外が export されていない。`src/domain/running` から prisma/react/next を import すると lint が失敗する |
| rollback | `src/domain/running/` と追加テストを削除、eslint 差分を戻す |

### R2 — Method / SessionTemplate / Envelope / Rule set

| 項目 | 内容 |
| --- | --- |
| 目的 | `rs-2026.09.0`（status=DRAFT）を JSON で作り、loader と不変性テストを整える |
| 新規ファイル | `src/domain/running/rules/{schema.ts,loader.ts,manifest.json}`、`src/domain/running/rules/sets/rs-2026.09.0.json`、`tests/fixtures/running/rs-test-a.json`・`rs-test-b.json`、`scripts/running-ruleset-hash.ts`（DRAFT 版の hash を manifest に書く）、`tests/domain/running/ruleset.test.ts`、`tests/domain/running/rules-manifest.test.ts` |
| schema / migration | なし / 不要 |
| domain type | RuleSet / MethodMeta / SessionTemplate / Envelope / EnvelopeCell / EligibilityRule / PlausibilityRule / TimingToleranceRule / StopPolicy |
| validation | `RuleSetSchema` の全 refine（§19.1） |
| tests | T-RV-01・T-RV-03・T-RV-04、T-EV-03（Moran を Envelope から参照できない）、T-STR-02（Envelope 部分）、template id と Method 値の非重複 |
| 既存互換 | 既存コードから使われない |
| 完了条件 | §3.3 の全 template、§5.6 の全 Evidence、§7.4 の全セル（judgement ラベル・evidenceIds 付き）、§4.4 の全 eligibility、§8.5 の全 plausibility、§10.2・§10.3 の全行が JSON にある |
| rollback | `rules/` と fixture・テストを削除 |

### R3 — Athlete context / maturity / training age

| 項目 | 内容 |
| --- | --- |
| 目的 | §4 を実装し、Tier と制約（許可集合）を確定する。**係数は使わない** |
| 新規ファイル | `src/domain/running/context/{ageBand,maturity,trainingAge,tier,constraints,performance,subject}.ts`、`tests/domain/running/context.test.ts`、`tests/domain/running/population.test.ts` |
| schema / migration | なし / 不要 |
| domain type | Subject / GroupProfile / AthleteProfile / MaturityAssessment / TrainingAgeInput / SubjectProfile / ReferenceResolution / VelocityEstimate |
| validation | 身長・記録の入力 plausibility（§8.5 入力行）、`schoolGrade` を maturity 推定に使っていないことのテスト |
| tests | T-POP-01〜07（eligibility 部分）、T-MISS-01・T-MISS-03・T-MISS-05、ageBand 境界、GROUP の最も制約の強い解決、§4.4 表の**全セルを表駆動テスト** |
| 既存互換 | 影響なし |
| 完了条件 | §4.4 の表が JSON と一致し、UNKNOWN と PRE の差分（SES の扱い等）がテストで区別されている |
| rollback | `context/` とテストを削除 |

### R4 — Planning engine（1項目）

| 項目 | 内容 |
| --- | --- |
| 目的 | `planRunningPrescription()` を §9.2 の step 1・3・6・7・8・9・10・12・13・15 で完成させる |
| 新規ファイル | `src/domain/running/planning/{normalize,eligibility,selection,envelope,individualize,confidence,placement,hardSafety,build,index}.ts`、`src/domain/running/rationale/{codes,render-ja}.ts`、`tests/domain/running/planning.test.ts`、`tests/domain/running/planning-grid.test.ts` |
| 未接続の step | 2・11 は `ReadinessDecision \| null` を素通し（null=NO_CHANGE）、4・5 は `NOT_EVALUATED`、14 は未実装（R5〜R7 で接続） |
| schema / migration | なし / 不要 |
| domain type | PlanRequest / PlanResult / RestPlan / EligibilityReason / RationaleLine |
| validation | `PlanRequestSchema`、`RunningPrescriptionSchema` |
| tests | PROPERTY/BOUNDARY グリッド（§20.1）、T-EV-02、T-MISS-01〜03、T-STR-01・T-STR-03、T-LSR-01・T-LSR-04（plan 部分）、T-POP-06、rest を短くする由来が無いこと、distance×秒の式が無いこと |
| 既存互換 | UI・DB 未接続 |
| 完了条件 | グリッド全組み合わせで PROPERTY の6条件が成立。rationale にエンジン内部の enum キーが出ない |
| rollback | `planning/` `rationale/` とテストを削除 |

- **[R4 errata]** 実装時の補足（R4 pre-commit 補正後）:
  - 追加の helper ファイル: `planning/schema.ts`（PlanRequest / PlanResult / CoachFieldEdit / CoachOverride / coachReference の Zod）、
    `planning/validatePrescription.ts`（RuleSet-aware な出力検証）。既存ファイルの変更は `types/prescription.ts`（§2.4 errata）、
    `evidence/confidence.ts`（§5.4 NOT_EVALUATED / NOT_REQUIRED）、`rules/schema.ts` と `rules/sets/rs-2026.09.0.json`・
    `rules/manifest.json`（§6.1 R4 errata の構造メタデータ。数値は不変）、`rules/loader.ts`（manifest の contentHash を返す）、
    `index.ts`（`planRunningPrescription` / `PlanRequest` / `PlanResult` のみ追加）。
  - step 2・11: `readiness` は null 固定（`readinessApplied=[]`）。step 4・5: Finding `PHASE_COMPETITION_NOT_EVALUATED` /
    `WEEKLY_CONTEXT_NOT_EVALUATED`（INFO）。step 14: 未実装（出力 plausibility・集計なし、`sessionFindings=[]`）。
  - eligibility: §4.4 の表と §8.2 の制約は R3 の解決結果をそのまま使い、R4 は下向きの判定だけを足す — requiresPhaseEvaluation の
    行は AUTO にしない（COACH は手動+REVIEW、AI/SYSTEM は INELIGIBLE）、`EligibilityRule.conditions` を満たさなければ `whenUnmet` に従う
    （AUTO 行は手動+REVIEW、MANUAL 行は override 不可の INELIGIBLE）、complexity が自動生成の上限を超えれば手動+REVIEW、advancedOnly
    （template / MethodMeta）は EnvelopeTier=ADVANCED かつ allowAdvancedMethods でなければ INELIGIBLE（COACH は override 可）。
    ASSISTED_SPRINT は構造化条件の結果が R3 `isAssistedManualCandidate` と一致することを防御的に確認する（不一致は RuleSet 不整合として BLOCKED）。
    planning は conditionNote・ruleId・templateId・event 名の文字列を解析しない（grep テストと、conditionNote / id を書き換えた RuleSet での
    同一結果テストで保証）。
  - BLOCK_AUTOGEN（§5.5 の LOW/POLICY_ONLY × HIGH_METABOLIC、MANUAL / 条件付き自動）は AI_PLANNER / SYSTEM にだけ適用し、
    PlanResult は `INELIGIBLE`。`ENVELOPE_INFEASIBLE`（Finding severity=BLOCK_AUTOGEN）は actor に関わらず `BLOCKED`
    （コーチは回数等を入力して解消する）。rs-2026.09.0 では位置上限（特に LOW / POLICY_ONLY → LOWER_HALF）と sessionVolumeM の
    下限が両立しない context があり（例: ADVANCED の ACC_BLOCK_10、DEVELOPMENTAL の TE_200 / TE_300、RACE_PACE / 同距離 best で
    1本の時間をエンジンが置く LONG）、その場合は数値を作らず BLOCKED になる（数値を広げて隠さない）。
  - 38 template の到達可能性監査（`planning-grid.test.ts`）: AUTO_REACHABLE 19 / COACH_MANUAL_REACHABLE 10（SES ×4 は §4.5 の phase 依存で
    R7 まで AI の自動生成なし、LONG ×6 は AI では参照が無いか HIGH_METABOLIC × POLICY_ONLY で自動生成なし）/ INTENTIONALLY_MANUAL_ONLY 9
    （TI ×2、RS_SLED_HEAVY、ASSISTED ×2、EVENT_APPROACH ×4）/ UNREACHABLE 0。AUTO 候補の行を持つ template で、eligibility を通過した
    AI の経路がすべて ENVELOPE_INFEASIBLE になるものは無い。

### R5 — Readiness / Pain gate

| 項目 | 内容 |
| --- | --- |
| 目的 | §13 を実装し、plan の step 2・11 に接続 |
| 新規ファイル | `src/domain/running/readiness/{painGate,actions,swap,aiSafeContext}.ts`、`tests/domain/running/readiness.test.ts` |
| 変更ファイル | `planning/index.ts`（step 2・11 の接続） |
| schema / migration | なし / 不要 |
| domain type | PainReport / ReadinessReport / ReadinessDecision / AiSafeSubjectContext |
| validation | `ReadinessReportSchema`（選択式のみ） |
| tests | T-SAFE-01〜04、T-AI-06、SWAP 後の eligibility 再評価 |
| 既存互換 | 影響なし |
| 完了条件 | 出力のどこにも割合・係数が現れない。red flag の STOP が override 不可 |
| rollback | 接続を外し R4 の素通しに戻す |

### R6 — Session aggregation / Plausibility / legacy 警告フック

| 項目 | 内容 |
| --- | --- |
| 目的 | §11 と §8.5 を実装し、plan の step 1（入力）と 14 に接続。legacy にも警告だけ足す |
| 新規ファイル | `src/domain/running/aggregation/{metrics,exposure,rules,legacyAdapter}.ts`、`src/domain/running/plausibility/{input,output}.ts`、`tests/domain/running/aggregation.test.ts`、`tests/domain/running/plausibility.test.ts` |
| 変更ファイル | `planning/index.ts`、`src/domain/prescription/calculate.ts`（**warnings に plausibility の文言を追加するだけ。数値は変えない**）、`tests/fixtures/prescription-legacy-warnings.json`（意図的更新） |
| schema / migration | なし / 不要 |
| domain type | SessionAggregate / AggregationItem / AggregationContext |
| validation | 集計入力の Zod |
| tests | T-AGG-01〜04、T-PLA-01〜04、legacy golden（数値 fixture）が無変更で通ること |
| 既存互換 | legacy の数値は同一。warnings が増えるだけ |
| 完了条件 | 監査 C-1 の2事例（80km・25.6km）が v2 と legacy の両方で検出される |
| rollback | 接続を外す。`calculate.ts` と warnings fixture を戻す |

### R7 — Weekly context / Phase / Competition / Taper（domain）

| 項目 | 内容 |
| --- | --- |
| 目的 | §12・§14 を実装し、plan の step 4・5 に接続 |
| 新規ファイル | `src/domain/running/weekly/{events,windows,guards}.ts`、`src/domain/running/competition/{phase,windows,taper}.ts`、`tests/domain/running/weekly.test.ts`、`tests/domain/running/competition.test.ts` |
| schema / migration | なし / 不要（LoadEvent と CompetitionRef は domain 型として受け取る） |
| domain type | LoadEvent / WeeklyContextResult / CompetitionRef / PhaseRule / CompetitionRule |
| tests | T-WK-01〜05、T-PH-01〜04 |
| 既存互換 | 影響なし |
| 完了条件 | Method 別の回復時間を持つ定数が存在しない。phase が hard stop・pain gate・rest 短縮に影響しない |
| rollback | 接続を外す |

### R8 — Runtime monitoring（domain）

| 項目 | 内容 |
| --- | --- |
| 目的 | §10 を実装。plan 出力に stop policy と tolerance を埋め込む |
| 新規ファイル | `src/domain/running/monitoring/{normalize,safety,timing,stopPolicies,decision}.ts`、`tests/domain/running/monitoring.test.ts` |
| 変更ファイル | `planning/build.ts`（stopPolicy・tolerance の埋め込み） |
| schema / migration | なし / 不要 |
| domain type | RepObservation / MonitorState / MonitorDecision / RepLogEntry / StopReason |
| validation | `RepObservationSchema` |
| tests | T-TIM-01〜06、T-LSR-02・T-LSR-03（monitor 部分）、T-PH-01 |
| 既存互換 | 影響なし |
| 完了条件 | `universalDropoffPercent` に相当する定数が存在しない。UNKNOWN 計時で数値 stop が発動しない |
| rollback | `monitoring/` と build 差分を戻す |

### R9 — 永続化（schema・MenuItem・Snapshot）

| 項目 | 内容 |
| --- | --- |
| 目的 | §16 の schema を適用し、v2 項目の保存と §17 のスナップショットを実装 |
| 変更ファイル | `prisma/schema.prisma`、`src/infra/repositories/session-repository.ts`（新列のコピー追加 + 作成前の読み取り専用評価）、`src/infra/repositories/menu-repository.ts`（`duplicateMenu` のコピー追加）、`tests/helpers.ts`（resetDb に Competition）、`scripts/verify-snapshot.ts`（**既存7項目は変えず** v2 の2項目を追加） |
| 新規ファイル | `prisma/migrations/<ts>_add_running_v2_prescription/`、`src/infra/repositories/{running-item,load-history,competition}-repository.ts`、`tests/repository/running/*.test.ts` |
| schema / migration | **あり / 必要**（§21 の手順。ユーザー承認と dev.db バックアップが前提） |
| domain type | Provenance / RunningMenuContext / [R9] `RunningPrescription.loadSnapshot`（§2.5 errata）/ `SessionPlanningEvaluationInput`・planningSnapshotJson（§17.3 errata） |
| validation | §19.2 の永続化整合規則 |
| tests | T-SNAP-01〜05、T-RV-02、既存 snapshot-integrity 9件（無改変） |
| 既存互換 | 既存行は LEGACY。既存画面は変更なし |
| 完了条件 | §21.2 の件数照合が一致。`createSessionFromMenu` がルールセット loader を呼ばないことをスパイで確認 |
| rollback | §21.3 |

### R10 — Server Actions ＋ メニュー編集 UI（コーチ手動）

| 項目 | 内容 |
| --- | --- |
| 目的 | コーチが v2 の走トレーニングをメニューに追加・編集・override できる |
| 新規ファイル | `src/actions/{running-actions,competition-actions,_actor}.ts`、`src/actions/{_running-plan-service,_running-template-options,_running-menu-evaluation,_running-menu-view}.ts`、`src/presentation/running/*.ts`、`src/components/running/{method-template-picker,running-item-editor,findings-list,confidence-badge,provenance-panel,target-split-editor,running-context-editor,running-item-create-form,running-item-panel,running-menu-panel}.tsx`、`tests/actions/running/*.test.ts`、`tests/presentation/running/*.test.ts` |
| 変更ファイル | `src/components/menu/menu-block-editor.tsx`（RUNNING_V2 項目の表示）、`src/components/menu/menu-item-form.tsx`（legacy 走系 Kind の推奨処方を無効化し v2 導線）、`src/actions/menu-actions.ts`（`updateMenuItemAction` に RUNNING_V2 ガード、add/move/delete 後の集計再評価）、`src/app/menus/[id]/page.tsx` |
| schema / migration | なし / 不要 |
| UI 規則 | enum キーを表示しない（L-4）／タップ領域 `h-8 w-8` 以上（CLAUDE.md）／「暫定ルール」「確信度」「根拠の出典種類」を表示／`RUNNING_V2_UI_ENABLED` で表示切替 |
| tests | Action の3ステップ、override に CoachActor 必須、T-AI-07、ガード |
| [R9 で確定した requirement] セッション作成 | RUNNING_V2 を含むメニューからセッションを作る application path は、`SessionPlanningEvaluationInput` を**必ず**生成して `createSessionFromMenu()` に渡す。評価に RuleSet が必要なときは、MenuItem の `ruleSetVersion` + `ruleSetContentHash` に一致する保存済み RuleSet を**明示的に**読む（`getActiveRuleSet` 等の active selector による silent upgrade 禁止。一致する版が読めなければ `RULESET_VERSION_UNAVAILABLE`）。同じメニューの RUNNING_V2 項目で version / hash が混在する場合は1版に統一せず、`MIXED_RULESET_VERSIONS`（NOT_EVALUATED）+ Finding `MIXED_RULESET_VERSIONS`（REQUIRE_COACH_REVIEW）で明示的に扱う。plannedAt が無ければ週次は `PLANNED_AT_UNAVAILABLE` |
| [R9 note / OPEN20 Phase 4B-G.5] 編集面・初回入力履歴 | `Provenance.coachEdits.field` は `EnvelopeField | "approachDistanceM"`。新規作成では、検証済み coach input のうち、成功した処方の origin が COACH authority として materialize した field だけを `{ at, field, to }` で記録する。値が `TEMPLATE_FIXED` と一致して planner に consumed された no-op は記録しない。変更前の処方値がない初回入力に `from` を捏造しない。作成後は、今回要求された field が成功した処方で COACH authority として materialize し、数値が変わった場合、または保存済み値の origin が COACH 以外から COACH へ移った場合に `{ at, field, from, to }` を記録する。後者では `from === to` が明示的な coach authority 採用を表す。既に COACH origin の同値再入力、TEMPLATE_FIXED のままの入力、今回要求されていない既存 coach 値の復元は記録しない。旧 provenance で `coachEdits` が無い場合は `[]` として読み込む。汎用 `updateMenuItem` 経路の RUNNING_V2 ガード（§15.3）もここで実装する |
| [R10-B4A / OPEN20 Phase 4B-G.6] Action contract | **(1) override の `confirmedTwice`**: Action の必須入力（`"true"` / `"false"` の明示値。未送信は入力エラー）で、そのまま domain の `coachOverrideSchema` に渡す（どの target で二重確認が必要かを Action / service に複製しない。service 内で true に固定・補完しない）。**(2) REQUIRE_CONFIRMATION の明示確認**: plan / edit / override / recalculate の4 Action は `confirmedFindingCodes[]` を受け取る。確認は CoachOverride ではない（reason・confirmedTwice を持たない）。service は**現在の入力で plan を再実行した結果**の REQUIRE_CONFIRMATION の code 集合（`requiredCodes`）と照合し、現在の結果に無い code が含まれていれば `CONFIRMATION_STATE_STALE`、不足があれば `CONFIRMATION_REQUIRED` で保存しない。確認は **Finding code 単位**（同じ code の Finding が複数あっても1回の明示確認でその code 群を確認した扱い）。以前の確認（保存済みの `findingConfirmations`）を edit / recalculate / override の新しい結果へ流用しない。override したこと自体を Finding の確認とみなさない。Session 作成時（B2）の aggregation REQUIRE_CONFIRMATION は別契約として **R11-B1 で実装した**（§22 の R11 行。Menu 側の確認記録を Session 作成の確認へ流用しない）。**(3) result**: 失敗は `kind`（`INVALID_INPUT` / `REJECTED` / `CONFIRMATION_REQUIRED` / `CONFIRMATION_STATE_STALE` / `PLAN_INELIGIBLE` / `PLAN_BLOCKED`）付き。Finding と不適格理由は B3 の presentation mapper で日本語化して返し、code は内部 payload だけに持つ。**(4) aggregate EnvelopeField**: EnvelopeField に存在することと直接編集できることは同義ではない。直接 edit できるのは `RunningPrescription` 内に一意に対応する一次 `FieldValue` だけで、`totalReps` / `sessionVolumeM` / `flyVolumeM` / `attempts` / `vdecPercent`（`AGGREGATE_ENVELOPE_FIELDS`）は Action が拒否し、UI は read-only（現在値・範囲の表示のみ。値から sets や距離を逆算しない）。**(5) approachDistanceM**: RuleSet に編集用の EnvelopeCell（recommended / coachEditable）は存在しない。新規作成時はコーチ入力としてのみ受け付け、Planner が `COACH_ENTERED` / `COACH_MANUAL_INPUT` で実際に materialize した値だけを Provenance に初回履歴として保存し、replan で復元する。保存後は既に `COACH_ENTERED` 値がある項目に限り、通常の edit Action で再入力できる。最終判定・plausibility 確認は常に Planner が行い、履歴は current request に含まれ、成功した処方で実際に coach authority として materialize した field だけへ追加する。UI は助走距離に推奨範囲・override を表示せず、未入力項目の作成後入力も許可しない。**(6) RunningMenuContext Action**: `updateRunningMenuContextAction` は実装済み `runningMenuContextSchema`（strict）の JSON だけを受け付け、健康情報キーを拒否し、`plannedDate` / `plannedAt` は明示値のまま保存する（当日で補わない）。flag OFF で拒否。**(7) picker**: `plannedDate` 基準の active RuleSet から template 候補 DTO を作る server provider（`_running-template-options.ts`）。一覧は候補であり eligibility の判定ではない（`canAttemptSelection`）。最終的な可否は `planRunningItemAction` の plan 結果 |
| [R10-B3] presentation layer | `src/presentation/running/` に表示用 DTO・日本語ラベル registry・Finding message registry・dose / confidence / provenance / template presenter を置く（表示専用。量の上限・rest の式・eligibility・大会 window・RuleSet 選択は持たない）。`components/running/*` は DTO だけを props で受け取り、RuleSet JSON / Prisma model / Server Action を import しない（`"use client"` は picker と editor だけ）。保存済み item の題名は `TEMPLATE_SELECTED.params.templateLabelJa` → `displayName` → exact RuleSet の `labelJa` の順、理由本文は保存済み `MenuItem.rationale`（再レンダリングしない）。Evidence の出典種類と aggregate field の範囲は、保存時の `ruleSetVersion + ruleSetContentHash` と完全一致した RuleSet だけから引く（不一致なら「根拠の詳細を確認できません」。active 版で代用しない）。editor は controlled component で、Action・`confirmedFindingCodes[]` への接続と `RUNNING_V2_UI_ENABLED` による切替は B4 の integration boundary |
| [R10-B4B] Menu UI integration | **(1) flag boundary**: `src/app/menus/[id]/page.tsx` は `isRunningV2UiEnabled()` が true のときだけ `buildRunningMenuView(menu)` を呼ぶ。OFF のときは Running v2 の読み込み・評価・DTO 生成を**一度も実行しない**（CSS で隠すのではない）。`MenuBlockEditor` / `MenuItemForm` は `running` / `runningV2Enabled` が未指定なら B4B 前と同一の描画（golden: `tests/presentation/running/legacy-menu-ui.test.ts`）。**(2) server 境界**: 画面へ渡すのは DTO だけ（`_running-menu-view.ts`）。RuleSet オブジェクト・Prisma モデル・処方 JSON を client へ渡さない。統合 component（`running-context-editor` / `running-item-create-form` / `running-item-panel` / `running-menu-panel`）は server 側へ **`"use server"` の Action か型 import 経由でしか**触らない。**(3) メニュー集計**: B2 が session 作成時に行っていた保存済みメニューの R6 評価を `src/actions/_running-menu-evaluation.ts` の `evaluateStoredRunningMenu()` として抽出し、B2（セッション日で `competitionDay` を判定）と B4B（メニューの `plannedDate` で判定。未設定なら `NOT_EVALUATED`）で共有する。policy を複製しない。版が混在していれば合計を出さず `MIXED_RULESET_VERSIONS` の説明（現行ルールで再計算すると揃う）を出す。**(4) context 編集**: 入力欄は `runningMenuContextSchema` にある項目だけ。**痛み・soreness・睡眠・疲労・体調・性別・生年月日などの健康 / 個人情報の入力欄を作らない**。計画日は必須で、今日の日付で補わない。`plannedAt` の暦日が計画日と違えばエラーにして**自動で直さない**（タイムゾーン offset は入力端末の値を明示的に付ける）。**(5) 走系 legacy 種目**: 走系かどうかは既存の分類 API（`src/domain/prescription/classify.ts` + `HIGH_INTENSITY_RUN_KINDS` + `TEMPO_AEROBIC`）で判定し、種目名の文字列リストを作らない。flag ON のとき legacy の「推奨処方を入れる」を出さず、走トレーニングの導線を案内する（legacy 入力自体は従来どおり保存できる。§R13 まで legacy ロジックは変更しない）。**(6) 保存済み項目**: 表示・編集は保存時の exact RuleSet のまま。版が現行へ動くのは「現行ルールで再計算」を押したときだけ。壊れた処方 JSON は題名だけ出し、数値を出さず合計も計算しない |
| 既存互換 | フラグ OFF で従来画面と同一 |
| 完了条件 | 手動で ACC・MV・STRIDE・LONG FULL を追加し、集計 Finding と provenance が表示・保存される |
| rollback | フラグ OFF。追加ファイルを削除 |

### R11 — 練習記録（実施時）UI・大会登録・Readiness 入力

| 項目 | 内容 |
| --- | --- |
| 目的 | セッション中の rep 入力と monitor 判定、当日 readiness、大会カレンダー |
| 新規ファイル | `src/components/running/{rep-logger,readiness-form,monitor-banner}.tsx`、`src/app/competitions/{page,new/page,[id]/page}.tsx`、`tests/actions/running/session-monitor.test.ts`、**[R11-B1]** `src/actions/_session-confirmation.ts`・`src/presentation/running/session-confirmation.ts`・`src/components/session/session-confirmation-panel.tsx`・`tests/actions/running/session-confirmation{,-challenge}.test.ts`・`tests/presentation/running/session-confirmation-ui.test.ts` |
| 変更ファイル | `src/components/session/session-item-row.tsx`（RUNNING_V2 項目で rep 入力）、`src/actions/session-actions.ts`（`recordRepAction`、actual 列のみ更新）、**[R11-B1]** `src/actions/{session-actions,_session-planning-service}.ts`（REQUIRE_CONFIRMATION を REJECT から2段階確認へ）・`src/domain/running/persistence/sessionSnapshot.ts`（`findingConfirmations?` + challenge canonicalization）・`src/domain/session/schema.ts`（確認入力）・`src/components/session/{start-session-form,new-session-from-menu}.tsx`・`src/components/submit-button.tsx`・`src/app/sessions/new/page.tsx`・`src/app/menus/[id]/page.tsx`（flag 受け渡し） |
| schema / migration | なし / 不要（R9 で追加済み） |
| 保存規則 | 部位・red flag・尺度値・raw report は保存しない。実施時は `readinessActionsJson` の versioned item execution payload と別列 `safetyOutcome` のみ（§13.5・§13.7） |
| [R11-B2] Readiness application contract | `evaluateSessionReadinessAction` は Session snapshot + session.date の loader policy（正式 DRAFT fallback 含む）+ 現在履歴から各 v2 item を評価し、v1 payload を atomic 保存。旧 array は再評価要求、reload は policy 非依存。詳細は §13.7。UI / rep logging は後続段階 |
| [R11-B3/B4B1] Monitor persistence / runtime acknowledgement contract | `recordRepAction` は保存済み処方 snapshot と envelope 内の append-only reps だけで R8 monitor を実行し、4 execution 列を raw content guard 付き transaction で保存する。`stopReason` は terminal MonitorAction summary、`safetyOutcome` は Readiness + Monitor の monotonic lifecycle maximum。`COACH_REVIEW` は review-instance-specific acknowledgement まで pauseし、ack は同じ envelope の別配列へ server timestamp とともに保存する。詳細は §13.8 / §13.9。UI は後続段階 |
| [R11-B6] 大会セッション | 明示的な大会実績はitemless COMPLETED Competition Session。1大会・1日1Sessionで、plural category集合にRACE / RELAY / mixedを保存する。mixedは同じsessionKeyの2 eventへ投影してHIGH session countは1。新plural破損はfail closed、旧singular/欠落は互換read。詳細は§13.13 |
| tests | actual 列だけが更新され planned 列が不変、COACH_ONLY の表示、STOP_SAFETY で以降の rep 入力を止める |
| [R11-B1] Session 確認 contract | **(1) 2段階確認**: `createSessionFromMenuAction` は1回目（確認入力なし）で `CONFIRMATION_REQUIRED` + 確認が必要な Finding（B3 で日本語化）+ `requiredFindingCodes`（内部 payload）+ `confirmationChallenge` を返し、Session row を作らない。2回目は `confirmedFindingCodes[]` + `confirmationChallenge` を受け取る。**(2) 現在の評価だけを使う**: 2回目も**以前の評価を使わず**メニュー / context を読み直して `buildSessionPlanningEvaluation()` を最初から再実行し、その結果の required code と照合する。**(3) 完全一致**: 不足は `CONFIRMATION_REQUIRED`、現在の結果に無い code（stale）は `CONFIRMATION_STATE_STALE`。重複入力は dedupe。判定は R10-B4A の domain helper（`requiredConfirmationCodes` / `evaluateFindingConfirmation`）を共有する。**(4) confirmation challenge = 現在の policy 評価の digest**: challenge は「コーチが確認した **Session planning evaluation**」を表す値であり、「Menu の指紋 + 確認対象 Finding」だけではない（[R11-B1.1]）。構成は `schemaVersion: 2` / `menuTemplateId` / `sessionDate` / `sourceMenuFingerprint`（§30〜§37 の MenuItem 指紋）/ `evaluationDigest` / 確認対象 Finding の canonical 値。`evaluationDigest` は `canonicalSessionConfirmationEvaluationPayload()`（domain・Node 非依存）を SHA-256 した値で、対象は **`SessionPlanningEvaluationInput` の policy 結果全体**: `sourceMenuFingerprint`、`aggregation`（status / reasons / RuleSet identity / `SessionAggregate` 全体＝区間・予算・completeness・findings）、`weeklyContext`（status / reasons / RuleSet identity / 項目ごとの coverage・highSessions7d・readinessRequired・weeklyPositionCap・autogenBlockedMethods・findings）、および evaluation の **全 Finding**（WARN / REQUIRE_COACH_REVIEW / BLOCK_AUTOGEN も含む）。Finding の canonical 値は `code` / `severity` / `scope` / `metric` / `value` / `limit`（Finding schema に実在する field だけ）。**含めないもの**: `findingConfirmations`（確認そのもの。入力へ循環させない）、時刻（`evaluatedAt` 等）、`events48h` / `events72h` の raw な LoadEvent 履歴、健康 / readiness の生値。field 順は明示し（`JSON.stringify` の並びに依存しない）、配列は安定ソート・null は保持・`undefined` は canonical から除外、重複 Finding は件数ごと保持。**時刻・乱数・秘密鍵を含めない**（同じ policy 評価なら再計算で必ず同じ値）。したがって MenuItem が同じでも、対象グループ設定（`availableMinutes` / `plannedAt`）・大会文脈・週次結果が評価結果を変えれば confirmation は流用できない。逆に **raw な入力（履歴の中身・評価時刻・policy に影響しない設定変更）だけが違って canonical な planning 結果が完全同一なら、以前の確認は有効**（confirmation は raw source data ではなく policy 結果に対して行う）。認可トークンではなく照合用の値で、DB へ保存しない（challenge / digest は request 間の transient state。保存するのは `findingConfirmations` の `{code, at}` だけ）。**(5) 同じ code でも中身が変われば流用不可**: code 一致でも challenge 不一致なら `CONFIRMATION_STATE_STALE`。本番 RuleSet の確認 Finding は `value` / `limit` を持たない（`code` + `metric` + `scope` のみ）ため、実際の差分は `sourceMenuFingerprint` が検出する。**(6) 確認対象が消えた場合**: 古い確認が送られてきたら silent create せず一度 `CONFIRMATION_STATE_STALE` を返す（確認入力なしの新しい要求で作成できる）。**(7) severity**: `BLOCK` は確認では解除できない（`REJECTED`）。`REQUIRE_COACH_REVIEW` / `BLOCK_AUTOGEN` は確認不要のまま作成できる。`MIXED_RULESET_VERSIONS` / `RULESET_VERSION_UNAVAILABLE`（NOT_EVALUATED）も確認要求に変えない。**(8) 監査記録**: `planningSnapshotJson.findingConfirmations?: [{ code, at }]`（backward-compatible optional。schemaVersion は 1 のまま。旧 snapshot はこの key を持たない）。保存するのは**その作成時の評価に実在した code だけ**で、`at` は server clock。確認しても `findings` から Finding を消さない。**(9) fingerprint 保護の継続**: 確認は `createSessionFromMenu()` の transaction 内の指紋再計算を迂回しない。確認通過後にメニューが変わっていれば `PLANNING_EVALUATION_STALE` で中止（Session row 0）。**(10) UI**: 共有 `SessionConfirmationPanel` を2つの入口（`StartSessionForm` / `NewSessionFromMenu`）の同じ form 内に置き、チェックと challenge を hidden field で送る（作成フォームの入力値は消えない）。チェックは既定 false・全確認までボタン無効・challenge が変われば全解除・自動再送なし。challenge hash と Finding code は画面に出さない。`RUNNING_V2_UI_ENABLED === "true"` のときだけパネルを表示し、Action / repository の fail-closed safety は flag に依存しない |
| 既存互換 | legacy 項目の実施記録は従来通り |
| 完了条件 | hand timing / photo cell / UNKNOWN の3通りで判定が §10 どおりに表示される |
| rollback | フラグ OFF |

### R12 — AI MenuPlanner 統合

| 項目 | 内容 |
| --- | --- |
| implementation gate | `src/domain/menu-planner/**` のpure port / strict schema / catalog validationが存在しcontract testが通ること。feature flag OFFでの開発実装はOPEN-20・DRAFT RuleSetに妨げられない |
| production gate | OPEN-20完了、RuleSet ACTIVE、`AI_MENU_PLANNER_ENABLED=true`。Runningを含む場合は`RUNNING_V2_UI_ENABLED=true`も必要 |
| 目的 | AI の提案を §18 の境界で v2 項目に変換する |
| [R10-B4A.1 requirement] 経路 | AI 処方は `provider output unknown → application strict parse → reason sanitize → allow-list validation → AI actor 専用 application path → domain planner`。Coach 専用の`running-actions.ts` / `_running-plan-service.ts`を経由しない（§18.5。eslintでimport禁止） |
| foundation | `src/domain/menu-planner/{contracts,port,catalog-validation,reason-sanitizer}.ts`。video AI namespaceと分離し、provider SDK / infra / Next / Prismaへ依存しない |
| application（後続） | write-0 preview、server binding、stale reject、server recompute、atomic DRAFT save。HMAC/token、Server Action、UI、provider adapterはfoundationに含めない |
| schema / migration | なし / 不要 |
| tests | strict request/proposal、numeric injection、clarification排他、catalog ID/method binding、sanitizer、provider unknown境界、dependency isolationに加え、後続でpreview write-0 / stale / atomic rollback / feature flag |
| 既存互換 | 種目カタログのみの提案は従来通り |
| 完了条件 | AI 経路から数値・override・版指定・Evidence を1つも渡せないことが型テストと実行時テストの両方で確認できる |
| rollback | running 提案の受け取りを外す |

### R13 — legacy の係数削除（Constraint 層の置き換え完了）

| 項目 | 内容 |
| --- | --- |
| 前提 | R3・R4 の全テスト通過、R10 で走トレーニングが v2 に切替済み、フラグ ON で一定期間運用 |
| 目的 | `LEVEL_VOLUME_FACTOR` / `PHASE_ADJUSTMENT` / legacy の走系 Kind（SPEED_* / TEMPO_AEROBIC）を削除し、legacy を非走種目専用にする |
| 変更ファイル | `src/domain/prescription/{constants,rules,calculate,classify}.ts`、legacy golden fixture（意図的更新）、`CLAUDE.md` |
| schema / migration | なし / 不要 |
| tests | legacy が走系 Kind を返さない、非走種目の golden は不変 |
| 完了条件 | リポジトリに「一律係数で量を増減する」コードが存在しない |
| rollback | git revert |

---

## 23. Risks

| # | リスク | 重要度 | 対策 |
| --- | --- | --- | --- |
| RK-01 | [SOURCE-BACKED] の数値も全件「二次報告のみ」。DR の誤読・誤引用が混入している可能性（Gemini の RCT 誤表示のような例） | Critical | `verification` と `provisional` を必須化、初期最高 confidence を MODERATE に制限、ルールセットを DRAFT のまま運用、一次資料照合を ACTIVE 化の条件にする（OPEN-20） |
| RK-02 | 認証が無く、「コーチ role」を実質的に強制できない（UI を触れる人は全員コーチ扱い） | High | AI 経路とコーチ経路をモジュールと型で分離（§18）。本格的な role はマルチユーザー対応時（OPEN-19） |
| RK-03 | 未成年の健康情報の扱い | High | 選択式のみ・非保存・AI 非送出（§13.5）。保存方針と保護者同意は OPEN-15 |
| RK-04 | GROUP の「最も制約の強い条件」で上級者に過小処方になる | Medium | ATHLETE subject を後続で実装（OPEN-01）。GROUP では目標タイムを出さない |
| RK-05 | ENGINE-POLICY の境界値（reps≤3、20m、2回連続、tolerance 等）が現場で合わない | Medium | すべてルールセット内のデータで持ち、改版で変更可能。コーチの override ログから見直し材料を得る |
| RK-06 | 高強度予算（§11.4）が厳しすぎて WARN が常態化し、警告が無視される | Medium | WARN と REVIEW を分け、BLOCK_AUTOGEN は coachEditable 基準だけにする。運用後に OPEN-06 で再検討 |
| RK-07 | 手動計時の tolerance が不適切で、早すぎる/遅すぎる終了 | Medium | tolerance/参照 > 10% は COACH_ONLY。値は provisional（OPEN-03） |
| RK-08 | legacy と v2 の併存期間の混乱（同じメニューに2種類の項目） | Medium | `prescriptionKind` 表示、legacy 走系の推奨処方を R10 で無効化、R13 で削除 |
| RK-09 | SQLite の RedefineTables でデータを失う | Medium | §21.2 のバックアップ・SQL レビュー・件数照合 |
| RK-10 | JSON 列の肥大・検索不能 | Low | サイズ上限、主要値は列化（§16.2）、PostgreSQL で Json 型へ |
| RK-11 | 型が複雑になり Sonnet の実装で `any` や型アサーションに逃げる | Medium | 各フェーズの完了条件に型テストを含める。`as` による method/template の変換を lint で警告（R1） |
| RK-12 | 大会の登録漏れで taper・前日規則が効かない | Medium | 大会ウィンドウは「登録された大会だけ」に効くことを UI に明示。race 実績は COMPETITION セッションで記録 |

---

## 24. Open Questions

| ID | 論点 | 本書での暫定扱い | 決める人・時期 |
| --- | --- | --- | --- |
| OPEN-01 | 選手個人（Athlete）の永続化と ATHLETE subject の UI | 型のみ。v2 は GROUP | プロダクト判断・R11 後 |
| OPEN-02 | 100m PB → Vmax 推定モデル | 実装しない（`vmaxEstimationModels: []`）。単一 PB→Vmax の検証済みモデルは無し（Vmax 導出には split time が要る）。UNSUPPORTED | CLOSED（OPEN20 一次資料照合） |
| OPEN-03 | HAND の距離依存項、FAT 専用 tolerance | HAND 0.25s（距離項 0）、FAT は PHOTO_CELL と同値 | 実測データ・計測文献 |
| OPEN-04 | RADAR/LASER の tolerance（m/s 単位） | COACH_ONLY | 同上 |
| OPEN-05 | 18–19歳の晩熟例の maturity 自動 POST | ADULT は自動 POST | コーチ判断 |
| OPEN-06 | 高強度予算（按分和 ≤ 1.0）の妥当性 | WARN のみ・provisional | 運用ログ + 研究 |
| OPEN-07 | ACCELERATION の session volume（100–300m か 100–160m か） | ADV 100–300m=BEST_PRACTICE_SYNTHESIS（Haugen Table 2）、DEV 60–160m=ENGINE_POLICY | CLOSED（OPEN20 一次資料照合） |
| OPEN-08 | DEV MV の fly volume 20–40m の出典（ChatGPT プリセットか Haugen youth 例か） | DEV 20–40m=ENGINE_POLICY、ADV 50–150m=BEST_PRACTICE_SYNTHESIS（Haugen）。fly-zone length と session fly volume は別 | CLOSED（OPEN20 一次資料照合） |
| OPEN-09 | DEVELOPMENTAL（POST）の LONG FULL の数値 | 手動のみ・EP 値 | コーチ + 研究 |
| OPEN-10 | DEVELOPMENTAL の TEMPO_EXTENSIVE 総量 | 400–1000m・EP | 同上 |
| OPEN-11 | コーチ独自の SessionTemplate を作れるようにするか | 作れない（ルールセット定数） | プロダクト判断 |
| OPEN-12 | TEMPO_INTENSIVE の強度帯（70–90 / 75–90 / 76–94 / 80–89 が不一致） | VITTORI_SE 90–95%=EVIDENCE_INFORMED（Special Endurance / 速度持久。intensive tempo 80–90% とは別概念）、COACH_DEFINED 70–94%=ENGINE_POLICY。intensityPercent は reference velocity 比 | CLOSED（OPEN20 一次資料照合） |
| OPEN-13 | EVENT_APPROACH_SPEED の試技数上限 | DEV 3–6 / ADV 4–8=ENGINE_POLICY（一次実験研究による hard ceiling は無し。quality stop は monitoring が扱う） | CLOSED（OPEN20 一次資料照合） |
| OPEN-14 | UKA「疾走1秒につき1–2分」と youth 例の不整合 | BEST_PRACTICE_SYNTHESIS/heuristic（hard physiological law / universal rule ではない）。Haugen full-recovery 帯が独立 support。KNOWN_PRIMARY_SOURCE_GAP（UKA 2019 原文未入手） | CLOSED（OPEN20 一次資料照合） |
| OPEN-15 | 痛み部位など健康情報の保存・傷害履歴・保護者同意 | 保存しない | 法務・プロダクト判断 |
| OPEN-16 | プライオ接地数・筋力負荷のセッション上限 | 上限なし（表示のみ） | 研究 |
| OPEN-17 | 高速曝露の週次急増ガード | 未実装 | 研究 |
| OPEN-18 | 個別コーチの taper テンプレート（Francis 10日型等） | 実装しない | プロダクト判断 |
| OPEN-19 | 認証と coach role の強制 | UI 経路 = コーチ | マルチユーザー対応時 |
| OPEN-20 | ルールセットを ACTIVE にする承認者と一次資料照合の手順 | 全版 DRAFT | ユーザー（コーチ）＋照合担当 |
| OPEN-21 | Special Endurance I/II の距離・時間境界 | template 名だけ持ち境界を定義しない | 研究 |
| OPEN-22 | `plannedDate` が無いテンプレートの週次評価 | 練習作成時にのみ評価 | UX 判断 |
| OPEN-23 | RESISTED_SPRINT の repDistanceM（10–30/10–40m 等）を裏付ける usage=PRESCRIPTION の一次資料 | ADV 10–30m=BEST_PRACTICE_SYNTHESIS（Haugen Table 2）、DEV 10–20m=ENGINE_POLICY。Petrakos の Vdec は load classification であり repDistance prescription ではない | CLOSED（OPEN20 一次資料照合） |

---

## 25. Final GO / NO-GO

### 判定: **GO WITH CONDITIONS（段階的 GO）**

Fable の Critical 8件は本書で次のように反映済み:

| Fable | 本書での対応 |
| --- | --- |
| C-1 UNKNOWN の既定 | §4.4（UNKNOWN と PRE を分けた保守表）、§22 R13（係数削除は Constraint 層の後） |
| C-2 Envelope が1本 | §7.4（DEVELOPMENTAL / ADVANCED を Method ごとに独立定義、Haugen youth 例を DEV 側の端点に） |
| C-3 集計ゲート | §11（セッション集計）、§12（全カテゴリの週次文脈）、§8.5（plausibility） |
| C-4 距離と時間の両立 | §3（Method と SessionTemplate を型で分離）、SES/LSR の一次軸を時間に、13–17秒ヒステリシス |
| C-5 SUBMAX 重複 | §3.1（SUBMAX を TI_VITTORI_SE に降格） |
| C-6 tolerance | §10.2（計時法依存・provisional・UNKNOWN は COACH_ONLY） |
| C-7 LONG の youth 危険 | §3.3・§10.3（recoveryStructure 必須、疲労許容は POST+ADVANCED のみ） |
| C-8 directness 静的保存 | §5.3・§5.4（runtime 導出と挙動への接続） |

| 範囲 | 判定 | 条件 |
| --- | --- | --- |
| **R0–R8**（domain のみ・schema 変更なし） | **GO** | R0 の golden 凍結を最初に行う。各フェーズの完了条件を満たしてから次へ |
| **R9**（schema 変更・migration） | **CONDITIONAL GO** | §16 の schema 案をユーザーが承認すること、dev.db のバックアップ、§21.2 の件数照合 |
| **R10–R11**（UI） | **CONDITIONAL GO** | R9 完了、フラグで切替可能にすること |
| **R12-A2以降の実装**（flag OFF） | **GO** | MenuPlanner foundation contract testを維持し、preview / accept / providerを段階実装する。DB・UI・provider接続は各段階の明示scopeに従う |
| **R12 production enable** | **NO-GO（現時点）** | OPEN-20完了、RuleSet ACTIVE、`AI_MENU_PLANNER_ENABLED=true`がすべて必要。DRAFT RuleSetで本番AI生成を有効にしない |
| **R13**（legacy 係数削除） | **NO-GO（現時点）** | R3・R4・R10 の完了と運用確認が前提 |
| ルールセットの ACTIVE 化 | **NO-GO（現時点）** | 一部の資料照合は完了したが、派生policy・未照合synthesisを含むRuleSet全体のOPEN20一次資料reconciliationと人間の承認が未完了 |

**本書は数値の科学的妥当性を保証しません。** [SOURCE-BACKED] は出典を持つ資料由来であることを示し、`PRIMARY_CHECKED` は対象資料を照合した記録、`SECONDARY_REPORT_ONLY` はDeep Research経由の未照合記録である。照合済み資料から派生したtier値・境界・運用値まで科学的に検証済みになるわけではない。[ENGINE-POLICY] は安全側に倒した運用値であり、科学的事実として画面や AI の文章に表示してはいけません。

---

**R12-A1B foundation status:** MenuPlanner port、strict request / provider / proposal schema、AI-safe catalog DTO、catalog-bound validation、reason sanitizerを実装。provider接続・preview・save・UI・DB / Prisma変更・migration・production enableは未実装。
