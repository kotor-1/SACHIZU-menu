#!/bin/sh
# Fly.io での起動。データは /data のボリュームにあり、イメージの更新では上書きしない。
set -eu
# 手元で試すときだけ DATA_DIR / APP_DIR で置き場所を変える。
DATA=${DATA_DIR:-/data}
APP=${APP_DIR:-/app}
mkdir -p "$DATA/app-data/exercise-video-guidance" "$DATA/import"

# 動画解説の保存先（<cwd>/.data）をボリュームに置く。
if [ ! -L "$APP/.data" ]; then
  rm -rf "$APP/.data"
  ln -s "$DATA/app-data" "$APP/.data"
fi

# 手元からのデータ取り込み（docs/DEPLOY_FLY.md）。置き換える前の DB は日時付きで残す。
if [ -f "$DATA/import/sachizu.db" ]; then
  stamp=$(date +%Y%m%d%H%M%S)
  for suffix in "" "-wal" "-shm" "-journal"; do
    if [ -f "$DATA/sachizu.db$suffix" ]; then mv "$DATA/sachizu.db$suffix" "$DATA/sachizu.db$suffix.before-import-$stamp"; fi
  done
  mv "$DATA/import/sachizu.db" "$DATA/sachizu.db"
  echo "imported database"
fi
if [ -f "$DATA/import/guidance.tar" ]; then
  tar -xf "$DATA/import/guidance.tar" -C "$DATA/app-data"
  rm "$DATA/import/guidance.tar"
  echo "imported video guidance"
fi

cd "$APP"
node node_modules/prisma/build/index.js migrate deploy
exec node node_modules/next/dist/bin/next start -H 0.0.0.0 -p "${PORT:-8080}"
