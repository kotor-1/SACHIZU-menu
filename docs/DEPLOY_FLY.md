# スマホ版（Fly.io）

GitHub Pages では動かない（データの保存とAI提案にサーバーが要る）ため、本体は Fly.io で動かす。

- URL: https://sachizu-menu.fly.dev
- main に送ると GitHub Actions（`.github/workflows/fly-deploy.yml`）が自動で更新する。

## ログイン
- 公開URLでは、ログインしないと何も開けない（画面・保存・AI提案・画面のファイル）。`src/proxy.ts` が毎回 DB と照合する。
- 最初の1人は `/login` で登録する。初回登録コード（Fly.io の `ACCOUNT_SETUP_CODE`）が必要で、その人が管理者になる。
  利用者が1人でもいれば初回登録は出ない。
- 2人目以降は、管理者が「設定」から追加する。パスワードの変更とログアウトも「設定」から。
- パスワードは scrypt で保存し、平文は残さない。10回続けて失敗すると15分ログインできない。
- ログインは30日有効。パスワードを変えると、ほかの端末のログインは解除される。利用者を削除すると、その人はすぐ入れなくなる。
- 表は `AppUser` / `AppSession`。動画解説の認証（Better Auth、無効のまま）とは別。
- 手元の開発（`npm run dev`）ではログインを求めない。`APP_AUTH_ENABLED=true` のときだけ求める。
  元の `prisma/dev.db` には表を足していない。

## 鍵
`zsh scripts/fly-set-secrets.sh` で登録する（値は画面に出ない。初回登録コードだけ最後に表示）。
- OPENAI_API_KEY … `.env.local` から読む（AI提案用）
- MENU_PLANNER_ACCEPT_TOKEN_SECRET … 提案の署名用。その場で乱数を作る
- ACCOUNT_SETUP_CODE … 最初の1人の登録用
- GitHub の FLY_API_TOKEN … 自動更新用（1年有効）

## データ
- DB は Fly.io のボリューム `/data/sachizu.db`（SQLite）、動画解説は `/data/app-data/exercise-video-guidance`。
- アプリを更新してもデータは残る。イメージには手元のデータを入れていない（`.dockerignore`）。
- **スマホ版と Mac の手元のアプリのデータは別々**。自動では同期しない。スマホでもパソコンでも、公開URLを開けば同じデータになる。
- 1台・1ボリュームで動かす（`--ha=false`）。SQLite のため台数を増やさない。ボリュームは毎日スナップショットが取られる（5日分）。

## 手元のデータを載せ直す（上書き）
置き換える前の DB は `/data/sachizu.db.before-import-<日時>` として残る。載せ直すと、スマホ版の利用者とログインも手元の DB の内容に置き換わる。

```sh
sqlite3 -readonly prisma/dev.db ".backup '/tmp/sachizu.db'"
tar -cf /tmp/guidance.tar -C .data exercise-video-guidance
fly ssh sftp put /tmp/sachizu.db /data/import/sachizu.db -a sachizu-menu
fly ssh sftp put /tmp/guidance.tar /data/import/guidance.tar -a sachizu-menu
fly machine restart -a sachizu-menu   # 起動時に取り込む
```

## 費用の目安
shared-cpu-1x・メモリ1GB・ボリューム1GB。使っていない間は自動で止まる（`auto_stop_machines`）。
最初のアクセスは起動のため数秒かかる。AI提案は1回ごとに OpenAI の利用料がかかる。
