#!/bin/zsh
# スマホ版（Fly.io）に鍵を登録する。鍵の値は画面にもログにも出さない。
#   - OPENAI_API_KEY … .env.local から読む（AI提案用）
#   - MENU_PLANNER_ACCEPT_TOKEN_SECRET … 提案の署名用。その場で乱数を作る
#   - ACCOUNT_SETUP_CODE … 最初の1人（管理者）の登録に使う。最初の登録に要るので、これだけ最後に表示する
#   - GitHub の FLY_API_TOKEN … main に送ったときの自動更新用（1年有効）
# 使い方: zsh scripts/fly-set-secrets.sh（Claude Code のチャットからは先頭に ! を付けて実行できる）
# 実行し直すと鍵と初回登録コードが新しくなる。登録済みの利用者とデータはそのまま残る。
set -euo pipefail
APP=sachizu-menu
REPO=kotor-1/SACHIZU-menu
FLY=${FLY:-$HOME/.fly/bin/flyctl}
ENV_FILE="${0:A:h:h}/.env.local"

OPENAI_KEY=$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?OPENAI_API_KEY[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" | head -n 1 | sed -E "s/^[\"']//; s/[\"'][[:space:]]*\$//")
[[ -n "$OPENAI_KEY" ]] || { print -r -- ".env.local に OPENAI_API_KEY が見つかりません。"; exit 1; }
SIGNING_KEY=$(openssl rand -hex 32)
# 読み間違えやすい 0/O・1/I を除いた32文字から12文字（256 は 32 で割り切れるので偏らない）
ALPHABET=ABCDEFGHJKLMNPQRSTUVWXYZ23456789
CODE=""
for byte in $(od -An -tu1 -N12 /dev/urandom); do CODE+=${ALPHABET[$(( byte % 32 + 1 ))]}; done
SETUP_CODE="${CODE[1,4]}-${CODE[5,8]}-${CODE[9,12]}"

printf 'OPENAI_API_KEY=%s\nMENU_PLANNER_ACCEPT_TOKEN_SECRET=%s\nACCOUNT_SETUP_CODE=%s\n' \
  "$OPENAI_KEY" "$SIGNING_KEY" "$SETUP_CODE" | "$FLY" secrets import -a "$APP" > /dev/null
print -r -- "✓ Fly.io に鍵を登録しました（値は表示していません）"

"$FLY" tokens create deploy -a "$APP" -x 8760h 2> /dev/null | gh secret set FLY_API_TOKEN -R "$REPO" > /dev/null
print -r -- "✓ GitHub に自動更新用の鍵（1年有効）を登録しました"

print -r -- "初回登録コード: $SETUP_CODE"
print -r -- "（スマホで https://sachizu-menu.fly.dev を開き、最初の登録で入力します。登録後は使えなくなります）"
unset OPENAI_KEY SIGNING_KEY
