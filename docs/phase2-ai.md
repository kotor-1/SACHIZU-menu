# Phase 2：動画解析（AI下書き）の追加手順

Phase 1 の時点で「動画 → 解析 → 下書き → コーチが修正 → 登録」のうち、
**解析の実行以外はすべて実装済み**です。この文書は、残りを埋める手順をまとめたものです。

> コード例では Qwen を挙げていますが、これは「今のところ有力な候補」というだけで、
> アーキテクチャが Qwen に依存しているわけではありません。
> Gemini・Claude・OpenAI など動画/画像を扱える VLM であれば同じ手順で差し替えられます
> （根拠は [0-A](#0-a-モデルプロバイダに依存しないこと) を参照）。

---

## 0. 全体の流れ（9 ステップ）

Phase 1.1 時点での状態を ✅（実装済み）／🔲（Phase 2 で追加）で示す。

| # | ステップ | 状態 | 実装（予定）場所 |
| - | --- | --- | --- |
| 1 | 動画アップロード | 🔲 | 新規（フォーム + アップロード先） |
| 2 | `VideoAsset` 作成 | 🔲 | 新規 Server Action（テーブルは作成済み） |
| 3 | `AnalysisJob` 作成（`PENDING`） | 🔲 | 新規 Server Action（テーブルは作成済み） |
| 4 | `VideoAnalyzer` へ動画を渡す | 🔲 | 新規実装が `analyze()` を呼ぶだけ（[ステップ1](#ステップ1アナライザを実装する)） |
| 5 | Structured Output を受ける | ✅ | `exerciseDraftPayloadSchema`（`src/domain/ai/draft-schema.ts`）が検証・無害化 |
| 6 | `ExerciseDraft` 作成 | 🔲 | 新規（4 の結果を保存するだけ。テーブル・payload 形式は確定済み） |
| 7 | コーチ確認 | ✅ | `/ai` の一覧 → `/exercises/new?draft=<id>` で prefill |
| 8 | `Exercise` 登録 | ✅ | 種目登録フォームの通常の送信（`exerciseInputSchema` で再検証） |
| 9 | Draft を `APPLIED` へ変更 | ✅ | `createExerciseAction` が 8 の成功時に自動で行う |

5 と 7〜9 が既に動くことは、`tests/actions/exercise-actions.test.ts` の
「AI draft boundary」テストで自動検証されている（下書き作成 → 登録 → `APPLIED` 化 → 紐付けを
実データで確認済み）。Phase 2 で新規実装するのは 1〜4 と 6 だけで、
そこから先（7〜9）は書き直す必要がない。

### 0-A. モデルプロバイダに依存しないこと

`VideoAnalyzer`（`src/domain/ai/ports.ts`）が受け取るのは
`{ videoUrl, mimeType?, durationSeconds?, hint? }`、返すのは
`{ draft, confidence, rawOutput, provider, model }` だけで、
どちらも特定ベンダーの語彙を含まない。`provider` / `model` は自由文字列であり、
型としてどこにも `"qwen"` を要求していない。

したがって Qwen（ローカル／API）・Gemini・Claude・OpenAI のどれであっても、
実装すべきことは同じ 1 点に集約される：「動画を渡したら
`exerciseDraftPayloadSchema` の形に沿った JSON を返す `analyze()` を書く」。
動画をそのまま渡せるモデルはそうし、フレーム抽出が要るモデル（実装によっては
静止画しか受け付けない場合がある）はその変換を **実装の内部に隠す** ——
呼び出し側（Domain・Server Actions・UI）は一切変更不要。

### 0-B. 失敗が Exercise を汚さないこと

`AnalysisJob.status`（`PENDING → RUNNING → SUCCEEDED / FAILED`）と
`errorMessage` は、実行ループを次の形にするために用意してある：

```ts
const job = await prisma.analysisJob.update({
  where: { id: jobId },
  data: { status: "RUNNING", startedAt: new Date() },
});

try {
  const result = await getVideoAnalyzer().analyze(input);
  await prisma.exerciseDraft.create({
    data: { analysisJobId: job.id, videoAssetId, payload: JSON.stringify(result.draft), confidence: result.confidence },
  });
  await prisma.analysisJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED", rawOutput: result.rawOutput, completedAt: new Date() } });
} catch (e) {
  // ExerciseDraft は作らない。失敗は AnalysisJob の中だけに留める。
  await prisma.analysisJob.update({
    where: { id: job.id },
    data: { status: "FAILED", errorMessage: e instanceof Error ? e.message : String(e), completedAt: new Date() },
  });
}
```

`catch` 節で `ExerciseDraft` を作らないのが要点。解析が失敗しても
`Exercise` はおろか `ExerciseDraft` にも汚染データが残らず、コーチには
「この動画は解析に失敗しました」とだけ見える状態になる。

### 0-C. 一括処理（動画 50 本 → 50 AnalysisJob → 50 ExerciseDraft）への拡張

`VideoAsset` / `AnalysisJob` / `ExerciseDraft` のどの関係にも
「1 件しか持てない」という制約（unique 制約や 1:1 前提のコード）がない。
`AnalysisJob.videoAssetId` は複数ジョブを許す通常の外部キー、
`ExerciseDraft` 側の `analysisJobId` / `videoAssetId` も任意（nullable）。

そのため一括処理は、0-B のループを **動画の数だけ繰り返すだけ**で実現できる
（`Promise.all` で並列化するか、キューに積んで順次処理するかは Phase 2 の実装判断）。
スキーマ変更もテーブル追加も不要。`/ai` の一覧は既に `take: 20` でページングされているため、
下書きが 50 件に増えても一覧画面自体は壊れない（古い分の閲覧用ページネーション UI は
Phase 2 の下書きレビュー画面を作る際に追加する）。

---

## 1. 現状（Phase 1 で用意済みのもの）

### テーブル

| テーブル | 役割 | Phase 1 の状態 |
| --- | --- | --- |
| `VideoAsset` | アップロードされた動画 1 件 | 作成済み・UI 未実装 |
| `AnalysisJob` | 解析ジョブ 1 件（状態・生出力・エラー） | 作成済み・未使用 |
| `ExerciseDraft` | AI が作った種目の下書き（JSON payload） | 作成済み・`/ai` で確認・登録できる |
| `Exercise` | 確定した種目 | 実装済み（`source` に `AI_DRAFT` を持てる） |

### コード

| ファイル | 役割 |
| --- | --- |
| `src/domain/ai/ports.ts` | `VideoAnalyzer` インターフェース。**ここが唯一の差し替え口** |
| `src/domain/ai/analyzer.ts` | `getVideoAnalyzer()`。現在は `NullVideoAnalyzer` を返す |
| `src/domain/ai/draft-schema.ts` | モデル出力を検証する Zod スキーマ。未知の値は捨てて落ちない |
| `src/app/exercises/new/page.tsx` | `?draft=<id>` で下書きをフォームに流し込む |
| `src/actions/exercise-actions.ts` | 登録成功時に下書きを `APPLIED` にして紐付ける |
| `src/app/ai/page.tsx` | 下書き一覧・確認・却下 |

`/ai` の「サンプル下書きを作る」で、解析なしでも導線を通して確認できます。

---

## 2. 追加する手順

### ステップ 1：アナライザを実装する

`src/infra/ai/qwen-analyzer.ts` を新規作成します。
`VideoAnalyzer` を満たすことだけが要件で、ほかの層は一切触りません。

```ts
import type {
  VideoAnalyzer,
  VideoAnalysisInput,
  VideoAnalysisResult,
} from "@/domain/ai/ports";
import {
  CURRENT_DRAFT_SCHEMA_VERSION,
  exerciseDraftPayloadSchema,
} from "@/domain/ai/draft-schema";

export class QwenVideoAnalyzer implements VideoAnalyzer {
  readonly provider = "qwen";
  readonly model = "qwen2.5-vl-72b";

  isAvailable() {
    return Boolean(process.env.QWEN_API_KEY);
  }

  async analyze(input: VideoAnalysisInput): Promise<VideoAnalysisResult> {
    const raw = await callQwen(input);            // ← 実装する部分
    const parsed = exerciseDraftPayloadSchema.safeParse(JSON.parse(raw.text));

    return {
      // 壊れた出力でも落とさない（schemaVersion は必須フィールドなので明示する）
      draft: parsed.success ? parsed.data : { schemaVersion: CURRENT_DRAFT_SCHEMA_VERSION },
      confidence: raw.confidence ?? null,
      rawOutput: raw.text,                        // 監査・再解析のため必ず残す
      provider: this.provider,
      model: this.model,
    };
  }
}
```

プロンプトは `exerciseDraftPayloadSchema` のフィールド名に合わせて JSON を返させます。
`category` / `metricType` / `targets` は既知の値以外を自動で捨てるようになっているので、
モデルが日本語のカテゴリ名を返しても壊れません。

### ステップ 2：差し替える

`src/domain/ai/analyzer.ts` の `getVideoAnalyzer()` に 1 行足します。

```ts
export function getVideoAnalyzer(): VideoAnalyzer {
  if (!cached) {
    cached = process.env.QWEN_API_KEY
      ? new QwenVideoAnalyzer()
      : new NullVideoAnalyzer();
  }
  return cached;
}
```

これで `/ai` の「解析エンジン：未接続」バッジが自動的に「接続済み」に変わります。

### ステップ 3：動画のアップロードと解析実行を足す

ここだけは新規実装が必要です。

1. アップロード先を決める（ローカル `public/uploads/` か S3 互換ストレージ）
2. `VideoAsset` を作る Server Action
3. `AnalysisJob` を `PENDING` で作り、解析を実行して `SUCCEEDED` / `FAILED` に進める
4. 成功したら `ExerciseDraft` を作る（`payload` に JSON 文字列、`analysisJobId` を紐付け）

4 まで来れば、その先（`/ai` に下書きが並び、`/exercises/new?draft=<id>` で修正して登録）は
**すでに動いています**。

---

## 3. 設計上の判断とその理由

### 下書きと確定データを別テーブルにした理由

AI の出力を直接 `Exercise` に書くと、確認前のデータがカタログと検索結果を汚します。
`ExerciseDraft` を挟むことで、コーチが承認したものだけがカタログに入り、
却下・再解析も破棄なしで扱えます。出どころ（`appliedExerciseId`）も残ります。

### `rawOutput` を必ず保存する理由

プロンプトを改善したときに、過去の動画を再解析せずに出力を見直せます。
モデルの挙動が変わった際の切り分けにも要ります。

### スキーマ検証で「捨てる」設計にした理由

VLM は未知のカテゴリ名や余計なフィールドを返します。厳格に弾くと下書きが 0 件になりますが、
`.catch()` で既定値へ落とすことで「部分的にしか埋まっていない下書き」を受け入れられます。
埋まらなかった欄はコーチが手で埋める前提です。

### `Exercise.source` / `status` を持たせた理由

AI 由来の種目は `source: "AI_DRAFT"` かつ `status: "DRAFT"` で登録されます。
一覧の状態フィルタで「確認済みだけ」に絞れるため、
AI が増やした種目が実運用のメニュー作成を邪魔しません。

---

## 4. 追加時に**作り直しが必要ない**ことの根拠

| 心配 | Phase 1 での手当て |
| --- | --- |
| 動画テーブルを後から足すとスキーマ変更になる | `VideoAsset` / `AnalysisJob` / `ExerciseDraft` は作成済み |
| AI の下書きをどこに置くか決まっていない | `ExerciseDraft.payload`（JSON）＋検証スキーマが確定済み |
| 下書きを編集する画面を新規に作る必要がある | 既存の種目登録フォームが `?draft=` で prefill 対応済み |
| 解析実装がアプリ全体に染み出す | 触るのは `VideoAnalyzer` 実装と `getVideoAnalyzer()` の 2 箇所のみ |
| AI 由来データが確定データと混ざる | `source` / `status` で区別し、検索フィルタにも露出済み |

残る新規実装は「動画の保存場所」と「ジョブ実行のトリガ」だけで、
これは Phase 2 で要件（ローカル保存か、クラウドか）が決まってから作るのが適切なため、
あえて Phase 1 では固定していません。

---

## 5. AI 出力 Schema（Phase 2 で使う予定。今回は定義のみ・Qwen 未接続）

実体は `src/domain/ai/draft-schema.ts` の `exerciseDraftPayloadSchema`
（Zod）。ここでは形と、依頼された例からどう変えたかを記録する。

### 5-A. 現在の形

```ts
{
  schemaVersion: 1,          // 省略時は自動で現在値になる（下の 5-C 参照）

  name: "ミニハードル・クイックステップ",
  nameKana: "みにはーどるくいっくすてっぷ",
  description: "等間隔に並べたミニハードルの間を…",
  coachingPoint: "母指球で弾む。腰の位置を落とさず…",
  commonMistake: "歩幅を合わせようとして減速し…",

  category: "DRILL",          // EXERCISE_CATEGORIES の 1 つ。未知の値は "OTHER" に丸める
  metricType: "DISTANCE",     // REPS | DISTANCE | TIME。未知の値は "REPS" に丸める
  difficulty: 2,              // 1〜5。範囲外は 3 に丸める

  targets: ["COORDINATION", "TECHNIQUE"],   // TRAINING_TARGETS。未知の値は捨てる
  generalTags: ["スプリントドリル"],
  equipmentTags: ["ミニハードル"],
  bodyPartTags: [],

  defaultSets: 3,
  defaultReps: null,
  defaultDistanceMeters: 15,
  defaultDurationSeconds: null,
  defaultRestSeconds: 60,

  observation: "選手は 10 台のミニハードルを 1 歩接地で通過…",  // 動画から読み取った所見（監査用）
}
```

全フィールドが任意（`schemaVersion` を除く）。モデルが一部しか埋められなくても
下書きとして成立し、残りはコーチが手で埋める前提。

### 5-B. 依頼時に示された例との対応

依頼時の例（`purpose` / `instructions` / `commonErrors` / `events` などを持つ形）は
汎用的なテンプレートであり、Phase 1 で確定した `Exercise` のドメインモデルとは
1 対 1 では対応しない。そのまま採用せず、次の対応表の通り
**既存のドメインに合わせて読み替えた**。

| 依頼時の例 | 本スキーマ | 理由 |
| --- | --- | --- |
| `name` | `name` | そのまま |
| `category` | `category` | そのまま（`EXERCISE_CATEGORIES` に限定） |
| `description` | `description` | そのまま |
| `instructions` | `description` に統合 | `Exercise` に実施手順専用の別フィールドがないため |
| `purpose` (配列) | 採用しない | `purpose` は `MenuTemplate`（メニューの狙い）の概念であり、個々の `Exercise` には持たせていない |
| `coachingPoints` (配列) | `coachingPoint` (単一文字列) | `Exercise.coachingPoint` が単一の `String?` のため。配列で返ってきた場合は実装側で改行結合すればよい |
| `commonErrors` (配列) | `commonMistake` (単一文字列) | 同上（`Exercise.commonMistake` に合わせる） |
| `events` (配列) | 採用しない | Phase 1 のドメインに「対象種目（100m・ハードル等の競技種目）」という概念がない。近いものは `category` と `tags` |
| `tags` (フラット配列) | `generalTags` / `equipmentTags` / `bodyPartTags` (種別ごと) | `Tag.kind` による分類が Phase 1 の設計の要（検索フィルタの軸）のため、フラット 1 本にしない |
| `difficulty` | `difficulty` | そのまま |
| `defaultSets` / `defaultReps` / `defaultDurationSeconds` / `defaultDistanceMeters` / `defaultRestSeconds` | 同名でそのまま | 完全一致 |
| （なし） | `schemaVersion` | 依頼された「versionを持たせる」対応として追加（5-C） |
| （なし） | `observation` | 動画から読み取った所見の自由記述。監査・再解析の判断材料として追加 |

`purpose` や `events` のような、Phase 1 のドメインに存在しない概念を
先回りしてスキーマに追加しなかったのは、それをやると
`Exercise` テーブル自体にカラムを足す必要が生まれ、Phase 1 の
Architecture（3 層の責務分離）に手を入れることになるため。
Phase 2 で実際にモデルの出力を見て、本当に必要になった時点で
`Exercise` のドメイン拡張とあわせて検討するのが正しい順序と判断した。

### 5-C. バージョニング

`schemaVersion`（現在値は `CURRENT_DRAFT_SCHEMA_VERSION = 1`）を
payload の JSON に含める。

- 省略された場合は自動的に現在値へ丸められる（例：このフィールド導入前に
  保存された下書きを読んでも壊れない）
- 数値でない値が来ても現在値に丸める（例外にしない）
- プロンプトや接続モデルを変えて **出力の形そのものを変える**（フィールドの
  意味を変える・必須化するなど、後方互換を壊す変更をする）ときは、
  この定数を上げてから `exerciseDraftPayloadSchema` を更新する。
  そうすれば「どの下書きがどの世代のプロンプト/モデルの出力か」を
  `payload.schemaVersion` を見るだけで判別できる。
- 見た目の文言修正など後方互換な変更（同じ意味のフィールドが増える等）は
  バージョンを上げなくてよい。

検証は `tests/domain/ai-draft-schema.test.ts` の
「schemaVersion (Phase 2 audit item: prompt/model provenance)」で自動チェックしている。

