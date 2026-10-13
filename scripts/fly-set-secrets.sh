#!/bin/zsh
# スマホ版（Fly.io）のパスワードと鍵を登録する。値は画面にもログにも出さない。
# 使い方: Mac の「ターミナル」で次を実行する（パスワードを入力するため、チャットの ! では実行しない）。
#   zsh "<このプロジェクト>/scripts/fly-set-secrets.sh"
# パスワードを変えたいときも、同じように実行し直せばよい。
set -euo pipefail
APP=sachizu-menu
REPO=kotor-1/SACHIZU-menu
FLY=${FLY:-$HOME/.fly/bin/flyctl}
ENV_FILE="${0:A:h:h}/.env.local"
# 登録時の書式で問題が出ない文字だけを使う
SAFE='^[A-Za-z0-9._@!-]+$'

print -r -- "スマホ版で使うユーザー名を入力してください（英数字。例: coach）"
read -r "APP_USER?ユーザー名: "
[[ "$APP_USER" =~ $SAFE ]] || { print -r -- "ユーザー名は英数字と . _ @ ! - だけにしてください。"; exit 1; }
print -r -- "パスワードを入力してください（12文字以上。英数字と . _ @ ! -。入力しても画面には出ません）"
read -rs "APP_PASSWORD?パスワード: "; print
read -rs "APP_PASSWORD_AGAIN?もう一度: "; print
[[ "$APP_PASSWORD" == "$APP_PASSWORD_AGAIN" ]] || { print -r -- "2回の入力が一致しません。"; exit 1; }
(( ${#APP_PASSWORD} >= 12 )) || { print -r -- "12文字以上にしてください。"; exit 1; }
[[ "$APP_PASSWORD" =~ $SAFE ]] || { print -r -- "パスワードは英数字と . _ @ ! - だけにしてください。"; exit 1; }

OPENAI_KEY=$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?OPENAI_API_KEY[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" | head -n 1 | sed -E "s/^[\"']//; s/[\"'][[:space:]]*\$//")
[[ -n "$OPENAI_KEY" ]] || { print -r -- ".env.local に OPENAI_API_KEY が見つかりません。"; exit 1; }
SIGNING_KEY=$(openssl rand -hex 32)

printf 'APP_BASIC_AUTH_USER=%s\nAPP_BASIC_AUTH_PASSWORD=%s\nOPENAI_API_KEY=%s\nMENU_PLANNER_ACCEPT_TOKEN_SECRET=%s\n' \
  "$APP_USER" "$APP_PASSWORD" "$OPENAI_KEY" "$SIGNING_KEY" | "$FLY" secrets import -a "$APP" > /dev/null
print -r -- "✓ Fly.io にパスワードと鍵を登録しました（値は表示していません）"

"$FLY" tokens create deploy -a "$APP" -x 8760h 2> /dev/null | gh secret set FLY_API_TOKEN -R "$REPO" > /dev/null
print -r -- "✓ GitHub に自動更新用の鍵（1年有効）を登録しました"
unset APP_PASSWORD APP_PASSWORD_AGAIN OPENAI_KEY SIGNING_KEY
