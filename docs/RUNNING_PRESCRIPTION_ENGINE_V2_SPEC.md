# Running Prescription Engine v2 Implementation Specification

- 文書バージョン: spec-rpe-v2.0.0（2026-09-15）
- 対象リポジトリ: SACHIZU メニュー作成（branch `main` / HEAD `ed63f91`。前回監査から `src/` `prisma/` は無変更を確認済み）
- 入力資料: `docs/` の6点（Audit v1 / Perplexity / Claude / ChatGPT / Gemini Deep Research / Fable 5.1 反証レビュー）
- 本書の性質: **実装仕様**。科学的再調査はしていない。数値の科学的妥当性を本書が保証するものではない。

## 0. 読み方

### 0.1 判断ラベル（全設計判断に付与）

| ラベル | 意味 | 実装上の扱い |
| --- | --- | --- |
| **[SOURCE-BACKED]** | 4つの Deep Research のいずれかが出典（著者・年・種類）を挙げて報告している | ルールデータに `EvidenceRecord` を必ず紐付ける。**ただし全件 `verification: "SECONDARY_REPORT_ONLY"`（一次資料は未照合）** |
| **[ENGINE-POLICY]** | 研究では決まらないため、本アプリが安全側・実装都合で決めたもの | `sourceType: "ENGINE_POLICY"`, `provisional: true` を付ける。**科学的事実として表示しない** |
| **[OPEN]** | 未決定。本書では暫定値または無効化で扱い、§24 に論点として残す | 暫定値を置く場合は ENGINE-POLICY と併記する |

> **重要**: [SOURCE-BACKED] の数値もすべて「二次報告のみ」です。Gemini の「Thomas 2018 = RCT」「10m=60秒は PCr 研究で強く支持」「女性はレスト×0.95」は Fable と他3レポートにより否定・弱化されているため、**本書では採用しません**。

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

[練習作成時]  createSessionFromMenu()：コピーのみ（再計算しない・ルール参照しない）
      ▼
 SessionItem（planned* + running snapshot 列）  ＋ evaluateWeeklyContext の結果を TrainingSession に保存

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
- [SOURCE-BACKED] 年間成長速度の急増（Claude DR が narrative review の 7.2cm/年を報告）→ **`rapidGrowthFlag`**。
  - [ENGINE-POLICY] flag=true のとき、申告 status に関係なく **CIRCA の制約を適用**。閾値 7.2cm/年は provisional。
- [ENGINE-POLICY] Mirwald 等の推定式は v2 初期ルールセットに**実装しない**（係数を一次資料で未照合）。入力として offset を受け取る場合も confidence 最大 MEDIUM。
- [ENGINE-POLICY] `maturityConfidence` の実効値: `method=NONE` → status を UNKNOWN に強制、`COACH_OBSERVATION/PARENT_REPORT` → 最大 MEDIUM、`GROWTH_VELOCITY`（2点以上・6か月以上間隔）→ 最大 MEDIUM、`MATURITY_OFFSET_EQUATION` → 最大 MEDIUM。HIGH は ageBand=ADULT のみ。

### 4.4 maturity UNKNOWN / LOW の既定挙動（Fable C-1 対応）

- 原則: **UNKNOWN/LOW を ADULT 扱いしない。ただし PRE と完全同一にもしない。** [ENGINE-POLICY]
- 実効カテゴリ: `status=UNKNOWN` または `confidence=LOW` → **`EFFECTIVE_UNKNOWN`**（`status=POST & confidence=LOW` も含む）。

| Method / Template | PRE | EFFECTIVE_UNKNOWN | CIRCA（または rapidGrowth） | POST（≥MEDIUM） |
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
  3. `rapidGrowthFlag = false`
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

- 初期ルールセットは全件 `SECONDARY_REPORT_ONLY` のため、**v2 初期の最高値は MODERATE**（HIGH は一次資料照合後にしか出ない）。

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
| EV_HAUGEN_2019_ACC_EXAMPLES | 加速 10–50m、youth 20m/約2分、elite 40m block/約7分 | COACHING_BEST_PRACTICE（UKA 由来） | PRESCRIPTION | [SOURCE-BACKED] |
| EV_HAUGEN_2019_MV_EXAMPLES | build 20–60m, fly 10–30m, youth 20+10/約4分, elite 40+30/約15分 | COACHING_BEST_PRACTICE | PRESCRIPTION | [SOURCE-BACKED] |
| EV_HAUGEN_2019_SES_EXAMPLES | 7–15秒・95–100%、youth 2–3×100m/約10分、elite 4–6×150m/20–30分 | COACHING_BEST_PRACTICE | PRESCRIPTION | [SOURCE-BACKED] |
| EV_HAUGEN_2019_VOLUME_TABLE | Acc 100–300m / MV fly 50–150m / SES 300–900m / Tempo 1000–2000m | COACHING_BEST_PRACTICE | PRESCRIPTION | [SOURCE-BACKED]（Perplexity・Gemini DR。Claude は Acc 100–160m と報告 → 不一致を applicabilityNotes に記載） |
| EV_HAUGEN_2019_TEMPO | 100–300m、約60–70% Vmax、prep 約2000m / comp 約1000m | ELITE_COACH_PRACTICE | PRESCRIPTION | [SOURCE-BACKED] |
| EV_HAUGEN_2019_VITTORI | 60–80m、約90→95%、rep 約2分 / set 約8分 | ELITE_COACH_PRACTICE | PRESCRIPTION（TI_VITTORI_SE のみ） | [SOURCE-BACKED] |
| EV_HAUGEN_2019_48H | 高強度セッションは通常48h程度離す | COACHING_BEST_PRACTICE | CHECK_ONLY | [SOURCE-BACKED] |
| EV_UKA_CLASSIFICATION | 強度帯（95–100 / 76–94 / <75）、完全/不完全回復 | COACHING_BEST_PRACTICE | CHECK_ONLY | [SOURCE-BACKED]（Claude DR） |
| EV_PETRAKOS_2016_VDEC | vdec <10 / 10–15 / 15–30 / >30% | SYSTEMATIC_REVIEW | PRESCRIPTION（band 分類のみ） | [SOURCE-BACKED] |
| EV_RESISTED_META_2024_2025 | resisted は主に 10m/加速に効果、重いほど良いとは言えない | META_ANALYSIS | CONTEXT_ONLY | [SOURCE-BACKED] |
| EV_ASSISTED_EVIDENCE_LIMITED | assisted の長期効果データは限定的 | SYSTEMATIC_REVIEW | CHECK_ONLY | [SOURCE-BACKED] |
| EV_MORAN_2016_YOUTH_DOSE | 週2回・約20m×最大16本・work:rest 1:25 または ≥90秒（男子ユース・主に団体競技） | META_ANALYSIS | **CONTEXT_ONLY / notForPrescription** | [SOURCE-BACKED]（Fable H-2 により処方不可） |
| EV_MATURITY_NOT_AGE | 暦年齢・学年から成熟度を確定しない | SYSTEMATIC_REVIEW + CONSENSUS | CHECK_ONLY | [SOURCE-BACKED] |
| EV_GROWTH_VELOCITY_7_2 | 成長速度 >7.2cm/年で傷害リスク上昇の目安 | NARRATIVE_REVIEW | CHECK_ONLY | [SOURCE-BACKED]（Claude DR のみ） |
| EV_BOSQUET_2007_TAPER | 約2週間、volume −41〜60%、intensity/frequency 維持（**短距離特異的ではない**） | META_ANALYSIS | PRESCRIPTION（ADVANCED × PEAK のみ） | [SOURCE-BACKED] |
| EV_RESISTED_RECOVERY_2023 | 20%BM resisted 後 30m 低下が 72h まで | CROSSOVER_REPEATED_MEASURES | CHECK_ONLY | [SOURCE-BACKED]（ChatGPT/Perplexity DR） |
| EV_THOMAS_2018 | squat/jump/sprint 後の疲労 48–72h（n=10 成人男性・15×30m・crossover。**RCT ではない**） | CROSSOVER_REPEATED_MEASURES | CHECK_ONLY | [SOURCE-BACKED]（Fable M-9 の訂正を反映） |
| EV_WELLNESS_SR | 主観的 wellness は負荷変化に客観指標より一貫して反応 | SYSTEMATIC_REVIEW | CHECK_ONLY | [SOURCE-BACKED] |
| EV_TIMING_ERROR_REPORTS | 手動計時の誤差・MDC、timing gate の CV 1.1–2.4% | OBSERVATIONAL | CHECK_ONLY | [SOURCE-BACKED]（Perplexity/Gemini DR） |
| EV_JAAF_JHS_GUIDE | 中学: 週≤16h、週5日+休養2日、平日約2h/休日約3h | GOVERNING_BODY_GUIDANCE | PRESCRIPTION（週次ガード） | [SOURCE-BACKED]（Claude DR のみ・一次未照合） |
| EV_JSPO_GROWTH_GUIDE | 発育期: 痛みがあれば休養、改善しなければ受診 | GOVERNING_BODY_GUIDANCE | PRESCRIPTION（安全ゲート文言） | [SOURCE-BACKED]（Claude DR のみ） |
| EV_JAAF_WIND_SPRINT | ウインドスプリント 100–150m×3–4 | GOVERNING_BODY_GUIDANCE | PRESCRIPTION（STRIDE） | [SOURCE-BACKED]（Claude DR のみ） |
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

### 7.4 rs-2026.09.0 の Envelope 値

表記: `推奨 / 編集可`。単位は列名。`—` = 該当なし。判断ラベル: **SB**=SOURCE-BACKED、**EP**=ENGINE-POLICY、**OP**=OPEN。

#### ACCELERATION（template が距離を固定）

| field | DEVELOPMENTAL | ADVANCED | 判断・根拠 |
| --- | --- | --- | --- |
| repDistanceM | 10–20 / 10–30 | 20–50 / 10–60 | DEV推奨 SB（youth 10–20: Claude DR）、ADV推奨 SB（10–50・上級 40–50: Haugen）、編集可 EP |
| totalReps | 4–8 / 3–10 | 3–8 / 2–12 | EP（ChatGPT DR の保守プリセット・envelope）。Moran 16本は **参照しない** |
| repsPerSet | 3–6 / 2–8 | 3–5 / 2–8 | EP |
| sets | 1–2 / 1–3 | 1–3 / 1–4 | EP |
| repRestS | 120–180 / 90–300 | 180–420 / 120–600 | youth 約2分・elite 約7分の例を端点に使用（SB）、幅は EP |
| setRestS | 240–420 / 180–600 | 300–600 / 240–900 | EP |
| sessionVolumeM | 60–160 / 40–200 | 100–300 / 80–400 | ADV推奨 SB（Haugen 表。Claude は 100–160 と報告 → OPEN-07）、DEV は EP |

#### MAX_VELOCITY（template が fly を固定）

| field | DEVELOPMENTAL | ADVANCED | 判断・根拠 |
| --- | --- | --- | --- |
| buildUpM | 15–25 / 15–30 | 30–60 / 20–70 | youth 20m・一般 20–60m・elite 40m（SB）、幅は EP。**選手の加速距離推定（§11.2）と矛盾する場合 Finding** |
| flyZoneM | 10–10 / 10–20 | 20–30 / 10–40 | youth 10m・elite 30m・範囲 10–30（SB）、編集可 EP |
| decelerationM | 20 固定 | 30 固定 | EP（露出に計上しない） |
| totalReps（fly 本数） | 2–3 / 1–4 | 3–6 / 2–8 | EP（ChatGPT/Perplexity DR） |
| sets | 1–1 / 1–2 | 1–2 / 1–3 | EP |
| repRestS | 180–300 / 150–420 | 480–900 / 240–1080 | youth 約4分・elite 約15分を端点（SB）、幅 EP |
| setRestS | — / 300–600 | 600–900 / 480–1200 | EP |
| flyVolumeM | 20–40 / 10–60 | 50–150 / 20–180 | ADV推奨 SB（Haugen 表）、DEV推奨 EP（ChatGPT プリセット。Fable は Haugen youth 例と記載 → OPEN-08） |

- 手動計時（HAND）で `MV_FLY10` を選んだ場合: 距離は変えず、Quality Stop を `COACH_ONLY` にする（§10.2）。[ENGINE-POLICY]（Gemini DR の「手動なら fly 20m 以上」は採用せず、計時法側で吸収）

#### SPRINT_ENDURANCE_SHORT（一次軸 = 時間）

| field | DEVELOPMENTAL | ADVANCED | 判断・根拠 |
| --- | --- | --- | --- |
| repDurationS | 7–12 / 6–13 | 7–15 / 6–17 | 7–15秒（SB: Haugen/UKA）。DEV 上限は EP |
| 分類ヒステリシス | 13–17秒 → `COACH_CONFIRM`（SES か LSR か） | 同左 | EP（Fable C-4） |
| totalReps | 2–3 / 1–4 | 4–6 / 2–6 | youth 2–3本・elite 4–6本の例（SB）、編集可 EP |
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
| intensityPercent（数値参照がある場合のみ） | 60–70 / 55–75 | 60–70 / 55–75 | 60–70%（SB: Haugen）、上限 75 未満（SB: UKA <75）、下限 55 は EP |
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
| intensityPercent | 90–95 / 88–95 | null / 70–94 | VITTORI SB（約90→95%）。COACH 上限 94 は UKA 76–94 に合わせた EP（DR 間で 70–90/75–90/80–89 と不一致 → OP-12） |
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
| vdecPercent（sled） | LIGHT <10、MODERATE 10–15（HEAVY 不適格） | LIGHT <10、MODERATE 10–15、HEAVY 15–30 | band 境界 SB（Petrakos 2016）。DEV で HEAVY を外すのは EP（DR 一致の方向性） |
| vdec 実測 | 無い場合 band は `measured:false`・confidence LOW。HEAVY は実測必須 | 同左 | EP |
| HILL | vdec を使わない（平地参照が無い） | 同左 | EP（Fable M-13） |
| repDistanceM | 10–20 / 10–30 | 10–30 / 10–40 | **EP**（§5.6 の Evidence には usage=PRESCRIPTION でこの数値を直接裏付ける記録が無いため、DEV・ADV とも ENGINE_POLICY として扱う。研究が存在しないという意味ではなく、初版 EvidenceRecord 構造では数値処方へ直接使える一次根拠を登録できていないための保守的処理。§24 OPEN-23 参照） |
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
| U15 | JAAF 中学ガイド（週≤16h・休養日2日）を週次ガードで評価（§12.4, REQUIRE_COACH_REVIEW） |
| U18 | 未成年の健康情報の取り扱い規則（§13.5）を適用 |
| ADULT | 追加制約なし |

- 早熟な U12（maturity=POST）でも U12 の制約は外れない。[ENGINE-POLICY]
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
| plausibility BLOCK | **不可**（入力を修正する） |
| hardSafety（将来の出典付き上限） | CoachOverride（理由 + 二重確認）。`nonOverridable` 指定のものは不可 |

判断: [ENGINE-POLICY]（Fable「override は人間 role 限定・ログ必須」を型で実装）。

### 8.4 競技団体ガイドライン [SOURCE-BACKED（Claude DR のみ・一次未照合）→ 挙動は ENGINE-POLICY]
- JAAF 中学校部活動: 週≤16時間、週5日＋休養2日、平日約2h・休日約3h → U15 の週次ガード（§12.4）。
- JSPO 発育期: 痛みがあれば休養、改善しなければ受診 → pain gate の出力文言（§13）。
- アプリはこれらの実時間を完全には把握できないため、**BLOCK にせず REQUIRE_COACH_REVIEW**。[ENGINE-POLICY]

### 8.5 Plausibility（rs-2026.09.0）[ENGINE-POLICY・provisional]

| 対象 | REQUIRE_CONFIRMATION | BLOCK |
| --- | --- | --- |
| 1本の距離（ACC/MV合計/SES/RS/AS/STRIDE） | > 150 m | > 300 m |
| 1本の距離（LONG） | > 600 m | > 1000 m |
| 1本の距離（TE/TI） | > 400 m | > 1000 m |
| buildUpM / flyZoneM | > 70 / > 40 | > 120 / > 80 |
| 1本の時間（LONG 以外） | > 20 s | > 120 s |
| repsPerSet / sets / totalReps | > 12 / > 6 / > 30 | > 30 / > 20 / > 80 |
| repRestS / setRestS | > 2400 / > 3000 | > 3600 / > 5400 |
| 1項目の総走行距離 | > 3000 m | > 10000 m |
| メニュー全体の総走行距離（§11） | > 8000 m | > 30000 m |
| sets/reps 取り違え疑い | `totalReps ≥ recommended.totalReps.max × 3` | — |
| 入力: 100m 記録 | < 9.0 s または > 25 s | < 5 s または > 60 s |
| 入力: fly 10m | < 0.80 s または > 2.5 s | < 0.5 s または > 5 s |
| 入力: 身長 | < 100 cm または > 220 cm | < 50 cm または > 260 cm |

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

### 11.3 null / UNKNOWN の伝播規則 [ENGINE-POLICY]
- 1項目でも bound が null → 合計のその bound は null、`completeness = "PARTIAL"`、Finding `AGG_INCOMPLETE_DATA`（INFO）。
- 上限との比較は `upper` を使う。`upper` が null なら `lower` で比較し、超えていなければ Finding `AGG_NOT_DETERMINABLE`（WARN）。**null を 0 にしない。**
- `actualHighSpeedExposureM` が null の SessionItem は planned 区間を `source: "PLANNED"` で使う（§10.5）。

### 11.4 判定規則（rs-2026.09.0）

| code | 条件 | severity | 判断 |
| --- | --- | --- | --- |
| AGG_METHOD_VOLUME_OVER_RECOMMENDED | 同一 Method の合計（sessionVolumeM / flyVolumeM / attempts）> tier の recommended.max | WARN | [ENGINE-POLICY]（「加速3項目で上限3倍」を塞ぐ） |
| AGG_METHOD_VOLUME_OVER_EDITABLE | 同上 > coachEditable.max | REQUIRE_COACH_REVIEW + BLOCK_AUTOGEN | [ENGINE-POLICY] |
| AGG_HIGH_INTENSITY_BUDGET | **高強度予算**: loadClass が HIGH_* の Method ごとに `合計 ÷ recommended.max` を求めた総和 > 1.0 | WARN | [ENGINE-POLICY・provisional] OPEN-06 |
| AGG_HIGH_INTENSITY_BUDGET_EDITABLE | 同じ総和を coachEditable.max で計算して > 1.0 | REQUIRE_COACH_REVIEW + BLOCK_AUTOGEN | [ENGINE-POLICY] |
| AGG_TEMPO_OVER | tempoVolumeM > TE の sessionVolumeM.recommended.max | WARN | [ENGINE-POLICY] |
| AGG_STRIDE_OVER | strideVolumeM > STRIDE の coachEditable.max | WARN | [ENGINE-POLICY]（STRIDE に TE の量を使わない） |
| AGG_TOTAL_RUNNING_CONFIRM / BLOCK | §8.5 の Session 行 | REQUIRE_CONFIRMATION / BLOCK | [ENGINE-POLICY] |
| AGG_COMPETITION_DAY_EXTRA | 大会当日のセッションに race 以外の HIGH_* 項目 | REQUIRE_COACH_REVIEW | [ENGINE-POLICY] |
| AGG_REST_INFEASIBLE | Σ(本数×rest) + 走行時間 > availableMinutes | WARN | [ENGINE-POLICY] |

- 高強度予算は**量への乗数ではなく、既存の Envelope 上限を按分する判定**。例: 同日に ACC 150m（上限 300m → 0.5）と MV fly 90m（上限 150m → 0.6）→ 1.1 → WARN（§20 T-AGG-03）。
- recommended が null の Method（ASSISTED・TI_COACH_DEFINED）は coachEditable.max を分母にする。
- plyometricContacts と strengthLoad には rs-2026.09.0 で上限を置かない（legacy の接地上限 120回は出典なし）。表示と週次文脈にのみ使う。[OPEN-16]

### 11.5 呼び出し箇所
- MenuItem の add / update / move / delete の各 Server Action（R10）。
- `createSessionFromMenu()` の直前（読み取りのみ）。結果は `TrainingSession.planningSnapshotJson` に保存（§16）。

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
| v2 SessionItem（done / 実施ログあり） | MethodMeta.weeklyLoadCategory | HIGH_* → HIGH、MODERATE → MODERATE、LOW → LOW |
| legacy SessionItem（Exercise.category=SPRINT/HURDLE/JUMP/STRENGTH） | RUNNING_HIGH_INTENSITY / HURDLES / PLYOMETRIC / STRENGTH | **UNKNOWN**（強度が記録されていない） |
| Exercise 削除済みの legacy 項目 | `SessionItem.loadCategory` スナップショット、無ければ OTHER | UNKNOWN |
| 大会セッション（`sessionKind="COMPETITION"`） | RACE / RELAY | HIGH |
| コーチ手入力（学校体育・他クラブ等） | 選択式 | 選択式 |
| 過去日付で `status=PLANNED` のまま | 元の category | 元の tag、completion=PLANNED_NOT_CONFIRMED（**実施したものとして扱う**） |

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

- `plannedDate` が null のメニュー（日付の無いテンプレート）では週次評価をせず `WEEKLY_NOT_EVALUATED`（INFO）。練習作成時（日付確定時）に必ず評価する。

### 12.4 7日間ガード [ENGINE-POLICY]（7日という日数自体は科学的最適値ではない）

| code | 条件 | severity | 判断 |
| --- | --- | --- | --- |
| WEEKLY_HIGH_SESSIONS | 直近7日の HIGH セッション（大会含む）が 3 以上 | WARN | 「高強度は週2回程度」の実践（Claude/ChatGPT DR）を方向として参照、閾値は EP |
| WEEKLY_JHS_REST_DAYS | U15 で直近7日に活動なしの日が 2 日未満 | REQUIRE_COACH_REVIEW | JAAF（Claude DR 経由・一次未照合） |
| WEEKLY_JHS_HOURS | U15 で記録上の練習時間合計 > 16h | REQUIRE_COACH_REVIEW | 同上 |
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

### 13.2 Pain gate（hard gate・計画時と実施時の両方）[ENGINE-POLICY]（方向: JSPO / Perplexity DR の hard stop 例）

| 条件 | 出力 | override |
| --- | --- | --- |
| redFlags に PAIN_AT_REST_OR_NIGHT / SWELLING / LIMPING / NUMBNESS_TINGLING / DIZZINESS_OR_BREATHING_DIFFICULTY / PAIN_PERSISTING_OVER_DAYS | `STOP`（当日の走処方なし。STRIDE も出さない）+ `MEDICAL_EVALUATION_RECOMMENDED` | 不可 |
| その他の redFlags（SUDDEN_SHARP_PAIN / PAIN_WORSENING_DURING_SESSION） | `STOP` + `COACH_REVIEW` | 不可 |
| status=PRESENT（red flag なし） | `CANCEL_HIGH_INTENSITY` + `REQUIRE_COACH_REVIEW` | 可（理由必須） |
| status=PRESENT、ageBand≠ADULT、部位 ∈ {HEEL, KNEE, HIP_PELVIS} | 上記 + 表示文「成長期の痛みの可能性があります。休養し、続く場合は受診を検討してください」（診断ではない） | 可 |
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

- 保存: v2 で永続化するのは `readinessActions`（enum 配列）と `safetyOutcome`（enum）だけ。**部位・red flag・尺度値は保存しない**（その場の判定にだけ使う）。傷害履歴として残すかは [OPEN-15]。
- テスト: `AiSafeSubjectContext` を JSON 化した文字列に `pain` `region` `redFlag` `soreness` `fatigue` `sleep` `birth` `sex` `maturity` のキーが含まれないこと（§20 T-AI-06）。

---

## 14. Phase / Competition / Taper

### 14.1 役割の分離（二重管理しない）[ENGINE-POLICY]

| 概念 | 保存場所 | 時間スケール | 変えるもの | 変えないもの |
| --- | --- | --- | --- | --- |
| Phase | `MenuTemplate.phase`（既存） | 数週間 | methodPriority（候補の並び）、TRANSITION の自動生成可否、volume の位置上限（§9.3）、種目特異性の優先 | hard stop、pain gate、rest を短くすること、tier、**fatigueTolerance（phase の属性として存在させない）** |
| CompetitionPriority | `Competition.priority`（新規 §16） | 大会の前後数日 | 大会ウィンドウ規則、近接時の eligibility、位置上限、taper ガイダンス、race の負荷イベント化 | 同上 |

- 優先: 計画日が優先度 NORMAL 以上の大会ウィンドウ内にあるとき、**eligibility と位置は大会規則が phase より優先**。phase は候補の並び順だけに効く。
- 日本の中高（4–10月にほぼ毎月大会）への対応: 毎回の記録会は `TRAINING_MEET` / `NORMAL` として登録し、**14日 taper を自動適用しない**。[SOURCE-BACKED 方針: ChatGPT DR / Fable M-10]

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
- [SOURCE-BACKED] Bosquet 2007: 約2週間、volume −41〜60%、intensity・frequency 維持。**持久系中心で短距離特異的ではない**（applicabilityNotes に保存し、画面にも表示）。
- [ENGINE-POLICY] 使うのは **ADVANCED tier × PEAK だけ**。出力は「週の総量を大会前の基準週から 41–60% の範囲で減らす目安」という**ガイダンス Finding（INFO）**と、量フィールドの位置 LOWER_HALF のみ。
  - 基準週の量（直近4週の週平均）が履歴カバレッジ不足で計算できない場合は、数値を出さず文章のみ。
- [ENGINE-POLICY] PRE / CIRCA / EFFECTIVE_UNKNOWN / DEVELOPMENTAL に **% の量削減を自動適用しない**。§14.3 の「新規刺激を入れない・大きな解糖系負荷を近接させない」で代替する。
- Charlie Francis 型 10日 taper 等の個別コーチ実践はテンプレートとしても実装しない（v2 範囲外、OPEN-18）。

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
| `createSessionFromMenu()` | 新列を**コピーするだけ**追加（§17）。コピー前に集計と週次評価を読み取り専用で実行し `TrainingSession.planningSnapshotJson` に保存。**エンジンの plan() もルールセットも呼ばない** |
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
  actualRepLogJson              String?   // RepLogEntry[]（痛みの部位は含めない）
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
| actualRepLogJson | rep ごとの可変長ログ |

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
    tier: EnvelopeTier; ageBand: AgeBand; maturityEffective: string; trainingAgeTier: TrainingAgeTier;
    phase: TrainingPhase | null; plannedDate: IsoDate | null; competitionWindows: string[];
    referenceKinds: string[]; historyCoverage72h: "COMPLETE" | "PARTIAL" | "NONE";
    readinessActions: ReadinessActionCode[];
  };
  evidenceIds: EvidenceId[];
  confidence: { prescription: PrescriptionConfidence; directness: Directness; inputData: Confidence };
  coachEdits: Array<{ at: IsoDateTime; field: EnvelopeField; from: number; to: number }>;
  overrides: Array<{ at: IsoDateTime; target: CoachOverride["target"]; from?: number; to?: number; reason: string }>;
  aiReason: string | null;                     // AI の説明文（数値・出典除去済み §18）
};
```

---

## 17. Snapshot Integrity

### 17.1 不変条件（既存 + v2 追加）
1. `TrainingSession` / `SessionItem` は `MenuTemplate` / `MenuItem` を**参照しない。展開時にコピーする**（既存・変更禁止）。
2. `createSessionFromMenu()` は**ルールセットを読まない・`plan()` を呼ばない・値を再計算しない**。
3. `SessionItem` の planned 系列（既存 planned* と v2 追加列）は**作成後に更新しない**。更新してよいのは actual 系列だけ。
4. ルールセットの改版、MenuItem の編集、Exercise の編集・削除、レンダラ（日本語文言）の変更は、**既存 SessionItem の計画値・理由文を変えない**。
5. Stop policy と timing tolerance は plan 時に `prescriptionJson` に**埋め込む**。monitor はスナップショットの値で判定する（ルールセット改版後も当時の基準で判定）。
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
| （Exercise.category → 対応表 §12.2、v2 は MethodMeta） | loadCategory | 追加（Exercise の名前と同じくコピー時点の値） |

### 17.3 スナップショット時の検証 [ENGINE-POLICY]
- JSON 列はコピー後に `RunningPrescriptionSchema` の**全 schemaVersion 対応パーサ**で検証する。
- 検証に失敗しても**コピーは中止しない・値を書き換えない**。`planningSnapshotJson.findings` に `SNAPSHOT_JSON_INVALID`（REQUIRE_COACH_REVIEW）を記録する。
- 過去版の説明表示は SessionItem のスナップショットだけで行う。ルールセットファイルの Evidence 詳細を表示する場合は `version` と `contentHash` の一致を確認し、不一致なら「版情報不一致」と表示する。

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

### 18.2 型

```ts
export type CoachActor = Brand<{ kind: "COACH"; ownerId: string }, "CoachActor">;
export type AiPlannerActor = { kind: "AI_PLANNER"; provider: string; model: string; requestId: string };
export type Actor = CoachActor | AiPlannerActor | { kind: "SYSTEM" };

export const aiRunningItemProposalSchema = z.object({
  blockName: z.string().trim().min(1).max(80),
  method: z.enum(RUNNING_TRAINING_METHODS),
  templateId: z.string(),                          // refine: active ruleSet に存在し method と一致
  positionPreference: z.enum(["LOWER", "MIDDLE"]).nullable(),
  reason: z.string().max(300),
}).strict();

export type AiPlannerProposal = {
  runningItems: z.infer<typeof aiRunningItemProposalSchema>[];
  exerciseItems: Array<{ blockName: string; exerciseId: string; reason: string }>;   // 既存カタログ
  question: { id: string; text: string; options: string[] } | null;                // 1問まで
};

/** AI 経路の変換。overrides / coachEdits は型で空に固定 */
export function proposalToPlanRequests(
  proposal: AiPlannerProposal, server: ServerPlanningContext, actor: AiPlannerActor,
): Array<PlanRequest & { overrides: []; coachEdits: []; actor: AiPlannerActor }>;
```

### 18.3 reason のサニタイズ [ENGINE-POLICY]
- 除去（その文を丸ごと削除し Finding `AI_REASON_SANITIZED` INFO）:
  - 用量表現: `/\d+\s*(m|メートル|秒|分|本|回|セット|set|%|％)/`
  - 出典らしき表現: `/(et al|doi|論文|研究によると|エビデンス|meta-analysis|メタ分析)/i`
  - 技術による中止指示: `/フォーム.*(崩|乱).*(中止|終了|やめ)/`（Fable M-4）
- 表示上は「AIの理由」と「エンジンの根拠」を別ラベルで並べる。

### 18.4 自動生成制限の適用範囲
- `BLOCK_AUTOGEN` Finding は **actor が AI_PLANNER / SYSTEM のときに適用**（その項目を生成しない）。コーチの手動選択では表示のみ（eligibility と override 規則は別途適用）。
- AI 由来の項目は `provenance.generatedBy.proposer = AI_PLANNER`、メニューは `status = "DRAFT"`。コーチが確認すると `acceptedByCoachAt` を記録。以後もすべて編集可能（要件F）。

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
| `RepObservationSchema` | monitor 入力 | timing=VIDEO なら fps 必須 |
| `CoachOverrideSchema` | override Action | reason ≥ 10文字、HARD_SAFETY/ELIGIBILITY は confirmedTwice=true |
| `CompetitionInputSchema` | 大会登録 | priority enum、date 必須 |
| `aiRunningItemProposalSchema` | MenuPlanner 出力の受け取り | `.strict()`、templateId の実在 |

### 19.2 永続化時の整合規則
- `prescriptionKind = "RUNNING_V2"` ⇒ `exerciseId = null`、`runningMethod`・`sessionTemplateId`・`ruleSetVersion`・`ruleSetContentHash`・`prescriptionJson`・`provenanceJson`・`rationale` が非 null、`sets`・`reps` が非 null。
- JSON サイズ上限: prescriptionJson ≤ 32KB、provenanceJson ≤ 16KB、actualRepLogJson ≤ 64KB。[ENGINE-POLICY]
- SQLite に CHECK 制約は入れない（既存方針）。整合はアプリ層で保証する。

---

## 20. Test Matrix

- すべて Vitest（既存構成・`fileParallelism: false`）。**新規パッケージは追加しない**。property / boundary テストは fast-check を使わず、**列挙型の全組み合わせ × 境界値の決定的グリッド**で行う。[ENGINE-POLICY]
- 置き場所: `tests/domain/running/**`（純粋関数）、`tests/repository/running/**`（DB）、`tests/actions/running/**`（Server Action、既存の `revalidatePath`/`redirect` モック規約に従う）。
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
| T-POP-03 | CIRCA / rapidGrowth | U15、申告 POST、成長速度 8cm/年 | CIRCA 制約が適用される |
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
| T-AGG-01 | 加速3項目 | DEV で ACC 各 120m × 3項目 | AGG_METHOD_VOLUME_OVER_*（監査 H-5 の再発防止） |
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
| T-PLA-01 | **80km accident** | TE で distance 5000 × reps 8 × sets 2 をコーチ入力 | 項目 BLOCK（>10000m）、Session BLOCK（>30000m）、override 不可 |
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
| domain type | Provenance / RunningMenuContext |
| validation | §19.2 の永続化整合規則 |
| tests | T-SNAP-01〜05、T-RV-02、既存 snapshot-integrity 9件（無改変） |
| 既存互換 | 既存行は LEGACY。既存画面は変更なし |
| 完了条件 | §21.2 の件数照合が一致。`createSessionFromMenu` がルールセット loader を呼ばないことをスパイで確認 |
| rollback | §21.3 |

### R10 — Server Actions ＋ メニュー編集 UI（コーチ手動）

| 項目 | 内容 |
| --- | --- |
| 目的 | コーチが v2 の走トレーニングをメニューに追加・編集・override できる |
| 新規ファイル | `src/actions/{running-actions,competition-actions,_actor}.ts`、`src/components/running/{method-template-picker,running-item-editor,findings-list,confidence-badge,provenance-panel}.tsx`、`tests/actions/running/*.test.ts` |
| 変更ファイル | `src/components/menu/menu-block-editor.tsx`（RUNNING_V2 項目の表示）、`src/components/menu/menu-item-form.tsx`（legacy 走系 Kind の推奨処方を無効化し v2 導線）、`src/actions/menu-actions.ts`（`updateMenuItemAction` に RUNNING_V2 ガード、add/move/delete 後の集計再評価）、`src/app/menus/[id]/page.tsx` |
| schema / migration | なし / 不要 |
| UI 規則 | enum キーを表示しない（L-4）／タップ領域 `h-8 w-8` 以上（CLAUDE.md）／「暫定ルール」「確信度」「根拠の出典種類」を表示／`RUNNING_V2_UI_ENABLED` で表示切替 |
| tests | Action の3ステップ、override に CoachActor 必須、T-AI-07、ガード |
| 既存互換 | フラグ OFF で従来画面と同一 |
| 完了条件 | 手動で ACC・MV・STRIDE・LONG FULL を追加し、集計 Finding と provenance が表示・保存される |
| rollback | フラグ OFF。追加ファイルを削除 |

### R11 — 練習記録（実施時）UI・大会登録・Readiness 入力

| 項目 | 内容 |
| --- | --- |
| 目的 | セッション中の rep 入力と monitor 判定、当日 readiness、大会カレンダー |
| 新規ファイル | `src/components/running/{rep-logger,readiness-form,monitor-banner}.tsx`、`src/app/competitions/{page,new/page,[id]/page}.tsx`、`tests/actions/running/session-monitor.test.ts` |
| 変更ファイル | `src/components/session/session-item-row.tsx`（RUNNING_V2 項目で rep 入力）、`src/actions/session-actions.ts`（`recordRepAction`、actual 列のみ更新） |
| schema / migration | なし / 不要（R9 で追加済み） |
| 保存規則 | 部位・red flag・尺度値を保存しない。`readinessActions` と `safetyOutcome` のみ（§13.5） |
| tests | actual 列だけが更新され planned 列が不変、COACH_ONLY の表示、STOP_SAFETY で以降の rep 入力を止める |
| 既存互換 | legacy 項目の実施記録は従来通り |
| 完了条件 | hand timing / photo cell / UNKNOWN の3通りで判定が §10 どおりに表示される |
| rollback | フラグ OFF |

### R12 — AI MenuPlanner 統合

| 項目 | 内容 |
| --- | --- |
| 前提 | Mobile Menu Builder v1 の MenuPlanner port（別設計 M7）が存在すること。無ければ本フェーズは着手しない |
| 目的 | AI の提案を §18 の境界で v2 項目に変換する |
| 新規ファイル | `src/domain/running/ai/{proposal-schema,sanitize,proposal-to-plan}.ts`、`tests/domain/running/ai-boundary.test.ts` |
| 変更ファイル | MenuPlanner 実装側（running 提案を受け取る部分のみ） |
| schema / migration | なし / 不要 |
| tests | T-AI-01〜07 |
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
| OPEN-02 | 100m PB → Vmax 推定モデル | 実装しない（`vmaxEstimationModels: []`） | 一次資料のある推定式が見つかったら改版 |
| OPEN-03 | HAND の距離依存項、FAT 専用 tolerance | HAND 0.25s（距離項 0）、FAT は PHOTO_CELL と同値 | 実測データ・計測文献 |
| OPEN-04 | RADAR/LASER の tolerance（m/s 単位） | COACH_ONLY | 同上 |
| OPEN-05 | 18–19歳の晩熟例の maturity 自動 POST | ADULT は自動 POST | コーチ判断 |
| OPEN-06 | 高強度予算（按分和 ≤ 1.0）の妥当性 | WARN のみ・provisional | 運用ログ + 研究 |
| OPEN-07 | ACCELERATION の session volume（100–300m か 100–160m か） | ADV 推奨 100–300m | 一次資料照合（Haugen 2019 本文） |
| OPEN-08 | DEV MV の fly volume 20–40m の出典（ChatGPT プリセットか Haugen youth 例か） | EP 扱い | 一次資料照合 |
| OPEN-09 | DEVELOPMENTAL（POST）の LONG FULL の数値 | 手動のみ・EP 値 | コーチ + 研究 |
| OPEN-10 | DEVELOPMENTAL の TEMPO_EXTENSIVE 総量 | 400–1000m・EP | 同上 |
| OPEN-11 | コーチ独自の SessionTemplate を作れるようにするか | 作れない（ルールセット定数） | プロダクト判断 |
| OPEN-12 | TEMPO_INTENSIVE の強度帯（70–90 / 75–90 / 76–94 / 80–89 が不一致） | COACH_DEFINED は編集可 70–94 | 一次資料照合 |
| OPEN-13 | EVENT_APPROACH_SPEED の試技数上限 | DEV 3–6 / ADV 4–8・EP | 跳躍・ハードル専門の研究 |
| OPEN-14 | UKA「疾走1秒につき1–2分」と youth 例の不整合 | 使わない | 一次資料照合 |
| OPEN-15 | 痛み部位など健康情報の保存・傷害履歴・保護者同意 | 保存しない | 法務・プロダクト判断 |
| OPEN-16 | プライオ接地数・筋力負荷のセッション上限 | 上限なし（表示のみ） | 研究 |
| OPEN-17 | 高速曝露の週次急増ガード | 未実装 | 研究 |
| OPEN-18 | 個別コーチの taper テンプレート（Francis 10日型等） | 実装しない | プロダクト判断 |
| OPEN-19 | 認証と coach role の強制 | UI 経路 = コーチ | マルチユーザー対応時 |
| OPEN-20 | ルールセットを ACTIVE にする承認者と一次資料照合の手順 | 全版 DRAFT | ユーザー（コーチ）＋照合担当 |
| OPEN-21 | Special Endurance I/II の距離・時間境界 | template 名だけ持ち境界を定義しない | 研究 |
| OPEN-22 | `plannedDate` が無いテンプレートの週次評価 | 練習作成時にのみ評価 | UX 判断 |
| OPEN-23 | RESISTED_SPRINT の repDistanceM（10–30/10–40m 等）を裏付ける usage=PRESCRIPTION の一次資料 | §5.6 に該当 Evidence が無いため ENGINE_POLICY（R2 で SOURCE_BACKED から降格。§7.4 RESISTED_SPRINT errata参照） | 一次資料照合 |

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
| **R12**（AI 自動生成） | **NO-GO（現時点）** | MenuPlanner port が未実装。加えて OPEN-20（ルールセットの一次資料照合と ACTIVE 化）が済むまで、AI による自動生成を本番で有効にしない |
| **R13**（legacy 係数削除） | **NO-GO（現時点）** | R3・R4・R10 の完了と運用確認が前提 |
| ルールセットの ACTIVE 化 | **NO-GO（現時点）** | 全 Evidence が SECONDARY_REPORT_ONLY。一次資料照合と人間の承認が必要 |

**本書は数値の科学的妥当性を保証しません。** [SOURCE-BACKED] は「Deep Research が出典を挙げて報告した」という意味で、一次資料との照合は未実施です。[ENGINE-POLICY] は安全側に倒した運用値であり、科学的事実として画面や AI の文章に表示してはいけません。

---

**今回コードを変更したか：NO**

- `src/` `prisma/` `tests/` `scripts/` `package.json` 等のリポジトリ内ファイルは変更していません。migration・package 変更・DB 書き込み・git 操作もしていません。
- 本仕様書は、ユーザー承認のうえ `docs/RUNNING_PRESCRIPTION_ENGINE_V2_SPEC.md` として保存した（設計書ファイルの追加のみ。git add / commit はしていない）。
