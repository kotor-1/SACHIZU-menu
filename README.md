# SACHIZU メニュー作成

陸上競技コーチのための、**トレーニングメニュー管理・作成アプリ**（Phase 1：基盤実装）。

種目（ドリル）を登録・検索し、それを組み合わせて練習メニューを作り、
1 回分の練習として実施・記録するところまでを扱います。

将来的に「ドリル動画 → AI が動作を言語化 → 種目情報を下書き → コーチが修正 → 登録」を
追加する前提で設計してあり、その差し込み口は Phase 1 の時点で用意済みです。

---

## セットアップ

```bash
npm install
npm run setup     # Prisma generate → マイグレーション → 初期データ投入
npm run dev       # http://localhost:3000
```

`npm run setup` で陸上競技の種目 25 件・メニュー 3 件・練習記録 1 件が入ります。
やり直したいときは `npm run db:reset`（DB を作り直して再投入）。

### 主なコマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー |
| `npm run build` / `npm start` | 本番ビルド / 起動 |
| `npm run typecheck` | 型チェック |
| `npm run lint` | ESLint |
| `npm test` | Vitest（Domain / Repository / Server Action の自動テスト） |
| `npm run verify` | typecheck → lint → test → verify-snapshot をまとめて実行 |
| `npm run db:migrate` | スキーマ変更をマイグレーション |
| `npm run db:seed` | 初期データ投入（既存データは消えます） |
| `npm run db:studio` | Prisma Studio で DB を直接見る |

---

## 技術構成

| 層 | 採用 |
| --- | --- |
| フレームワーク | Next.js 16（App Router / React Server Components） |
| 言語 | TypeScript（strict） |
| データ | Prisma + SQLite（`prisma/dev.db`） |
| 更新処理 | Server Actions（API ルートは持たない） |
| 検証 | Zod |
| UI | Tailwind CSS v4 |

**なぜ SQLite か**：Phase 1 は単一コーチ運用で、`npm run dev` だけで動くことを優先しました。
アクセスはすべて `src/infra/repositories/` を経由するため、PostgreSQL へ移す際は
`schema.prisma` の provider 差し替えと `String` → `enum` の置換で済みます。

---

## ディレクトリ構成

```
prisma/
  schema.prisma          DB スキーマ（責務分離の意図をコメントで記載）
  seed.ts                初期データ
src/
  domain/                アプリの語彙。DB にも React にも依存しない
    shared/              共通の列挙値・Prescription（負荷の値オブジェクト）・Zod ヘルパ
    exercise/            種目の分類軸と入力スキーマ
    menu/                メニューの分類軸と入力スキーマ
    session/             練習記録の状態と入力スキーマ
    ai/                  ★ AI 拡張ポイント（ports.ts / analyzer.ts / draft-schema.ts）
  infra/
    db/prisma.ts         PrismaClient（dev の多重生成を防ぐ）
    repositories/        DB アクセスはすべてここに閉じる
  actions/               Server Actions（検証 → repository → revalidate）
  app/                   画面（App Router）
  components/            UI コンポーネント
  lib/                   フォーム変換・日付整形
scripts/
  verify-snapshot.ts     設計上の不変条件を実データで検証するスクリプト（手動実行用）
tests/
  domain/                Prescription・Zod ヘルパ・検索条件・AI下書きスキーマの単体テスト
  repository/            Exercise/Menu CRUD・検索・★スナップショット不変条件の自動テスト
  actions/               Server Action（AI下書きの紐付け、チェックボックス解析など）
```

---

## データモデルの中心：3 つの責務分離

このアプリの設計は、次の 3 つを**別のもの**として扱うことに尽きます。

### 1. `Exercise` — 種目そのもの（知識）

「Aスキップ」という動作の定義。誰が・いつ・どれだけやるかとは無関係です。
説明、コーチングポイント、ありがちな失敗、対象能力、練習目的、対象競技、
そして**推奨負荷**を持ちます。推奨負荷はあくまで既定値で、
メニューへ入れるときの初期値として使われます。

似た種目を作るときは複製（コピーして少し変える）できます。
よく使う種目にはお気に入りを付けて一覧からすぐ絞り込めます。

### 2. `MenuItem` — このメニューでの処方（計画）

同じ「Aスキップ」でも、メニュー A では 2set×30m、メニュー B では 3set×20m。
**どうやるか**はメニュー側が持ちます。ここを Exercise から分けているのが要点で、
種目の推奨値を変えても既存メニューは動きません。

構造は `MenuTemplate > MenuBlock（ウォームアップ／主運動…）> MenuItem`。

> **`MenuTemplate` が「テンプレート」の役割を担います。** このアプリには
> 独立した Template エンティティはありません。「Menu = 再利用可能な練習計画」
> 「Session = Menu 等から生成された実施記録」という 2 層で成立する設計を
> 正式採用しています（テンプレート機能が未実装なのではなく、Menu 自体が
> その役割を持つ、という意図的な設計判断です）。

### 3. `SessionItem` — 実際にやった事実（記録）

メニューから練習を起こすとき、内容を**参照ではなくコピー**します
（`createSessionFromMenu`）。種目名・ブロック名・計画値をスナップショットとして持ち、
実績値（`actual*`）を並べて記録します。

この結果、次が保証されます（`npx tsx scripts/verify-snapshot.ts` で検証できます）：

- テンプレートの負荷を後から変えても、作成済みの練習記録は変わらない
- 種目名を変えても・種目を削除しても、記録には当時の名前が残る
- メニューを削除しても、そこから起こした練習記録は消えない

### 補助テーブル

- `Tag` … `kind`（`GENERAL` / `EQUIPMENT` / `BODY_PART`）で 1 つの仕組みに統合。検索フィルタの主役。
- `ExerciseTarget` … 対象能力（加速・最高速・持久力…）。中間テーブルで検索対象にしています。
- `ExercisePurpose` … 練習目的（接地・姿勢・リズム…）。対象能力とは別軸で、より具体的な着眼点。
- `ExerciseEvent` … 対象競技（短距離・ハードル・走幅跳…）。この種目がどの種目の選手向けか。
- `Exercise.isFavorite` … よく使う種目をすぐ見つけるための目印（真偽値のスカラー列）。

> SQLite は enum とスカラー配列を持てないため、enum 相当は `String` +
> `src/domain/**/constants.ts` の const union、配列相当は中間テーブルで表現しています。

---

## 画面

| パス | 内容 |
| --- | --- |
| `/` | ホーム（件数・予定の練習・最近のメニュー） |
| `/exercises` | 種目一覧・検索（キーワード／カテゴリ／対象能力／練習目的／対象競技／難易度／タグ／状態／お気に入り） |
| `/exercises/new`, `/exercises/[id]`, `/exercises/[id]/edit` | 種目の登録・詳細・編集 |
| `/menus` | メニュー一覧・検索（**含まれる種目名でも引ける**） |
| `/menus/[id]` | メニューの組み立て（ブロック／項目の追加・並べ替え・処方の上書き） |
| `/sessions` | 練習記録一覧（期間・状態で絞り込み） |
| `/sessions/[id]` | 実施記録（チェック、実績入力、コーチ所感） |
| `/ai` | 動画解析（AI 下書き）— Phase 1 では解析エンジン未接続 |

検索条件はすべて URL クエリに載るため、リロード・ブックマーク・戻るがそのまま効きます。

---

## AI 拡張ポイント（Phase 2）

詳細は [`docs/phase2-ai.md`](docs/phase2-ai.md) を参照してください。要点だけ：

- 解析処理は `src/domain/ai/ports.ts` の **`VideoAnalyzer` インターフェース 1 つ**に閉じています
- DB（`VideoAsset` / `AnalysisJob` / `ExerciseDraft`）は Phase 1 で作成済み
- 「下書き → 登録フォームへ prefill → 登録」の導線（`/exercises/new?draft=<id>`）も実装済み

Phase 2 で必要なのは、アナライザの実装と `getVideoAnalyzer()` の差し替えだけで、
スキーマ変更も画面の作り直しも発生しません。

---

## Phase 1 でやっていないこと

- 認証・マルチユーザー（`ownerId` 列だけ用意し、既定値 1 つで運用）
- 動画のアップロードと解析の実行（`VideoAsset` テーブルはあるが UI 未実装）
- 選手個人の記録管理（`groupName` の自由記述のみ）

自動テストは `npm test`（Vitest、100 件超）と `scripts/verify-snapshot.ts`
（手動実行の不変条件チェック）を用意済み。E2E テストは未整備。
