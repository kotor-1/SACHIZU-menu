# CLAUDE.md

このリポジトリで作業するときの前提。

## アプリの目的

陸上競技コーチ向けのトレーニングメニュー管理・作成アプリ。
種目カタログ → メニュー組み立て → 練習の実施記録、が主軸。
Phase 2 で Qwen 等による動画解析（種目の AI 下書き）を足す予定。

## 使用モデルの方針

- **Opus 5** … 設計、DB / Entity 変更、責務分離に関わる判断、複数ファイルにまたがる変更、
  原因が読めないバグ、大きなリファクタリング、Phase 全体レビュー
- **Sonnet 5** … Architecture 確定後の定型実装（CRUD 画面、フォーム、一覧、Filter、
  CSS 調整、文言修正、小規模なバグ修正）。設計変更や Schema 変更が必要になったら Opus 5 へ戻す
- **Fable 5.1** … 設計の第三者レビュー・セカンドオピニオン。実装の量産には使わない

## 絶対に壊してはいけない設計

`Exercise` / `MenuItem` / `SessionItem` の責務分離がこのアプリの背骨。

| 層 | 意味 | 変えてよいもの |
| --- | --- | --- |
| `Exercise` | 種目そのもの（知識） | 種目の定義・推奨負荷 |
| `MenuItem` | このメニューでの処方（計画） | メニュー固有の負荷。Exercise には波及しない |
| `SessionItem` | 実際にやった事実（記録） | 実績値のみ。計画値は展開時のスナップショット |

**セッションはメニューを参照しない。展開時にコピーする。**
`createSessionFromMenu()`（`src/infra/repositories/session-repository.ts`）がその実装。
ここを「参照に変えれば正規化できる」と直したくなるが、それをやると
テンプレートの編集が過去の練習記録を書き換えてしまう。絶対に参照に変えないこと。

不変条件は `npx tsx scripts/verify-snapshot.ts` で検証できる。
データモデルに触ったら必ず実行する。

**`Exercise` へ分類軸を足すこと自体は問題ない。** Phase 1.2 で
`Exercise.purposes` / `Exercise.events` / `Exercise.isFavorite` を
`ExerciseTarget` と同型の中間テーブル（1 Exercise : N）で追加したが、
これは「Exercise（知識）に付く属性を増やした」だけで 3 層構造そのものは
変えていない。**`SessionItem` へはコピーしていない** —
Purpose/Event/Favorite は種目カタログの分類・検索のための情報であり、
「その回の練習で何をどれだけやったか」という実施記録には意味を持たないため。
新しい分類軸を Exercise に足すときは、まず「これは SessionItem の
スナップショットに含める必要があるか」を自問し、不要ならこれまで通り
Exercise 側だけに留めること。

## Running Prescription Engine v2（開発中）

走トレーニング処方の作り直しが進行中。**正式仕様は
[`docs/RUNNING_PRESCRIPTION_ENGINE_V2_SPEC.md`](docs/RUNNING_PRESCRIPTION_ENGINE_V2_SPEC.md)
の1本のみ**。長い内容をここへ複製しないので、詳細は必ずそちらを読むこと。
ここには実装中に忘れてはいけない不変条件だけを書く。

守ること:
- **3 層責務分離は Running v2 でも絶対に変えない。** `Exercise` = 知識、
  `MenuItem` = 計画、`SessionItem` = 実績。Running Prescription Engine は
  `MenuItem` を作るための domain engine であり、**第4の永続層ではない**
  （エンジン専用テーブルを作らない）
- **`SessionItem` の snapshot integrity を壊さない。** `createSessionFromMenu()`
  のコピー方式（参照ではない）は Running v2 でも同じ。これは
  `tests/repository/snapshot-integrity.test.ts` と `scripts/verify-snapshot.ts`
  で検証する
- **現行の `src/domain/prescription/`（legacy）は正式仕様の Phase R13 まで
  勝手に削除・修正しない。** 数値も分類も、必要な Constraint 層・置き換え先が
  揃うまでは現状のまま残す
- **legacy の走系の係数（レベル係数・期分け係数）や分類ミスは、R0 時点では
  「正しいもの」として認定しない。** `tests/domain/prescription-legacy-golden.test.ts`
  と `tests/fixtures/prescription-legacy-golden.json` /
  `prescription-legacy-warnings.json` は、あくまで**現在の挙動を固定するため
  の characterization test**であり、科学的正しさの保証ではない
- **`npm run db:seed` / `npm run db:reset` / `npm run setup` は実行禁止。**
  現在の実データ（Exercise 158件など）を消去する
- **Phase は正式仕様の R0 → R1 → … の順に実施する。** 前の Phase の完了条件
  （テスト・typecheck・build 等）を満たす前に、次の Phase の実装を先行させない
- **`git add .` は使わない。** リポジトリには大容量の未追跡動画・scratch 系
  ファイルがあるため、変更したファイルだけを明示的に `git add` すること

## 層の約束

- `src/domain/` … DB にも React にも依存しない。列挙値・値オブジェクト・Zod スキーマだけ
- `src/infra/repositories/` … Prisma へのアクセスはすべてここ。画面から直接 Prisma を叩かない
  （例外：ダッシュボードの単純な件数集計のみ `prisma` を直接使っている）
- `src/actions/` … Server Actions。「検証 → repository → revalidatePath」の 3 ステップに留める
- `src/app/` … 表示。データ取得は repository 経由

## SQLite 由来の制約

- enum が使えない → `String` + `src/domain/**/constants.ts` の const union
- スカラー配列が使えない → 中間テーブル（`ExerciseTarget` / `ExerciseTag`）
- `mode: "insensitive"` が使えない → `contains` をそのまま使う（日本語主体なので実害なし）

PostgreSQL へ移行するときは、この 3 点を戻すだけで済むように書いてある。

## フォームの約束

- チェックボックスは未チェックだと値が送られない。
  hidden で既定値を先に置き、`getAll()` で判定する（`checkbox()` ヘルパ）
- 数値入力は空文字で届く。`optionalNumber()` が `null` に落とす
- DB を読むページで `searchParams` を使わないものは `export const dynamic = "force-dynamic"` が必要
  （付け忘れるとビルド時に固定されて更新が反映されない）

## AI 拡張

`src/domain/ai/ports.ts` の `VideoAnalyzer` が唯一の差し替え口。
追加手順は `docs/phase2-ai.md`。ここ以外に解析ロジックを書かない。

## 自動テスト（Vitest）

`tests/` に Domain / Repository / Server Action の単体テストがある
（`npm test` で 100 件超。テスト用 DB は `prisma/test.db` を使い、
`prisma/dev.db` には触らない）。

データモデルや Server Action に触ったら、既存のテストが通るか必ず確認する。
特に `tests/repository/snapshot-integrity.test.ts` は上のスナップショット不変条件の
自動版なので、`Exercise` / `MenuItem` / `SessionItem` 周りを触ったら最優先で流す。

新しいテストを足すときの注意:
- Server Action（`"use server"`）は `next/cache` の `revalidatePath` と
  `next/navigation` の `redirect` を `vi.mock()` する
  （`redirect` は実際の Next.js と同様、呼ばれたら例外を投げるモックにする。
  `tests/actions/*.test.ts` を参照）
- テストファイルをまたぐ並列実行は無効（`vitest.config.ts` の `fileParallelism: false`）。
  同じ SQLite ファイルを共有しているため、有効にすると "database is locked" が起こる

## タップ領域の最低ライン

一覧・記録画面のアイコンだけの操作ボタン（並べ替え・編集・削除）は
最低でも `h-8 w-8`（32px）、隣接ボタンとの間は `gap-1`（4px）以上を保つ。
特にチェックボックスなど「繰り返し何度もタップされる」操作は、
他の補助ボタンより一回り大きくする（`session-item-row.tsx` の実施済みトグルが例）。
`h-5 w-5` 以下のアイコンボタンを新しく追加しないこと。

## 確認コマンド

```bash
npm run typecheck
npm run lint
npm test
npx tsx scripts/verify-snapshot.ts
npm run build
```

まとめて実行する場合は `npm run verify`。
