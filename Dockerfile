# Fly.io 用のイメージ。データ（DB・動画解説）はイメージに入れず、/data のボリュームに置く。
FROM node:26-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 CHECKPOINT_DISABLE=1

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# ビルド中だけ使う空の DB。静的ページの生成に使うだけで、イメージには残さない。
RUN DATABASE_URL=file:/tmp/build.db node node_modules/prisma/build/index.js generate \
  && DATABASE_URL=file:/tmp/build.db node node_modules/prisma/build/index.js migrate deploy \
  && DATABASE_URL=file:/tmp/build.db NODE_ENV=production node node_modules/next/dist/bin/next build --webpack

FROM base AS run
ENV NODE_ENV=production PORT=8080
COPY --from=build /app /app
RUN chmod +x /app/scripts/fly-start.sh
EXPOSE 8080
CMD ["/app/scripts/fly-start.sh"]
