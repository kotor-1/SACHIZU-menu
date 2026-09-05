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

## 確認コマンド

```bash
npm run typecheck
npm run lint
npx tsx scripts/verify-snapshot.ts
npm run build
```
