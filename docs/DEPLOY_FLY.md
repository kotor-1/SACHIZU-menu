# スマホ版（Fly.io）

GitHub Pages では動かない（データの保存とAI提案にサーバーが要る）ため、本体は Fly.io で動かす。

- URL: https://sachizu-menu.fly.dev
- 開くとユーザー名とパスワードを聞かれる。Fly.io の Secrets にだけ置いてあり、リポジトリには入れていない。
- main に送ると GitHub Actions（`.github/workflows/fly-deploy.yml`）が自動で更新する。

## データ
- DB は Fly.io のボリューム `/data/sachizu.db`（SQLite）、動画解説は `/data/app-data/exercise-video-guidance`。
- アプリを更新してもデータは残る。イメージには手元のデータを入れていない（`.dockerignore`）。
- **スマホ版と Mac のデータは別々**。自動では同期しない。
- 1台・1ボリュームで動かす（`--ha=false`）。SQLite のため台数を増やさない。

## 手元のデータを載せ直す（上書き）
置き換える前の DB は `/data/sachizu.db.before-import-<日時>` として残る。

```sh
sqlite3 -readonly prisma/dev.db ".backup '/tmp/sachizu.db'"
tar -cf /tmp/guidance.tar -C .data exercise-video-guidance
fly ssh sftp shell -a sachizu-menu   # put /tmp/sachizu.db /data/import/sachizu.db、put /tmp/guidance.tar /data/import/guidance.tar
fly machine restart -a sachizu-menu  # 起動時に取り込む
```

## パスワード・鍵
- 登録と変更: `zsh scripts/fly-set-secrets.sh`（ターミナルで実行。値は画面に出ない）
  - APP_BASIC_AUTH_USER / APP_BASIC_AUTH_PASSWORD … 入室用（12文字以上）
  - OPENAI_API_KEY … `.env.local` から読む（AI提案用）
  - MENU_PLANNER_ACCEPT_TOKEN_SECRET … 提案の署名用。その場で乱数を作る
  - GitHub の FLY_API_TOKEN … 自動更新用（1年有効）
- パスワードが未設定、または12文字未満の間は、公開を止める（503）。

## 費用の目安
shared-cpu-1x・メモリ1GB・ボリューム1GB。使っていない間は自動で止まる（`auto_stop_machines`）。
最初のアクセスは起動のため数秒かかる。AI提案は1回ごとに OpenAI の利用料がかかる。
