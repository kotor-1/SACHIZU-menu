# Phase 2：Qwen による動画解析の追加手順

Phase 1 の時点で「動画 → 解析 → 下書き → コーチが修正 → 登録」のうち、
**解析の実行以外はすべて実装済み**です。この文書は、残りを埋める手順をまとめたものです。

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
import { exerciseDraftPayloadSchema } from "@/domain/ai/draft-schema";

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
      draft: parsed.success ? parsed.data : {},   // 壊れた出力でも落とさない
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
