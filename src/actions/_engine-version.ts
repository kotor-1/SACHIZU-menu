/**
 * Running Prescription Engine v2 — Provenance.engineVersion（§16.3・R10-B1 §24）。
 *
 * `package.json` の version + ビルド時に注入された git 短縮 hash。
 * `Date.now()` / `Math.random()` は使わない（同じビルドなら常に同じ値になる）。
 * client bundle には出さない（"use server" を付けない server module から呼ぶ）。
 *
 * 短縮 hash は `RUNNING_ENGINE_BUILD_SHA`（ビルド時に CI 等で設定する想定）から読む。
 * 未設定（ローカル開発など）のときは明示的に `local` にする（偽の hash を作らない）。
 * 実行のたびに `git rev-parse` を呼ぶことはしない（デプロイ環境に git が無いことがあるため）。
 */
import packageJson from "../../package.json";

const SHORT_SHA_LENGTH = 7;

export function engineVersion(): string {
  const sha = process.env.RUNNING_ENGINE_BUILD_SHA?.trim();
  const shortSha = sha && sha !== "" ? sha.slice(0, SHORT_SHA_LENGTH) : "local";
  return `${packageJson.version}+${shortSha}`;
}
