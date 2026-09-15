import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Running Prescription Engine v2（docs/RUNNING_PRESCRIPTION_ENGINE_V2_SPEC.md §1.6）:
  // src/domain/running/** は DB にも React にも AI SDK にも依存しない純粋 domain。
  // このブロックだけがこの制限の対象で、プロジェクト全体には適用しない。
  {
    files: ["src/domain/running/**/*.ts", "src/domain/running/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              message:
                "src/domain/running/** は React に依存できません（正式仕様 §1.6）。",
            },
            {
              name: "react-dom",
              message:
                "src/domain/running/** は React に依存できません（正式仕様 §1.6）。",
            },
            {
              name: "@prisma/client",
              message:
                "src/domain/running/** は Prisma に依存できません（正式仕様 §1.6）。Prisma アクセスは src/infra/repositories/ の責務です。",
            },
            {
              name: "openai",
              message:
                "src/domain/running/** は AI SDK に依存できません（正式仕様 §1.6, §18）。差し替え口は将来 src/infra/ai/ に置きます。",
            },
            {
              name: "@anthropic-ai/sdk",
              message:
                "src/domain/running/** は AI SDK に依存できません（正式仕様 §1.6, §18）。差し替え口は将来 src/infra/ai/ に置きます。",
            },
            {
              name: "@google/generative-ai",
              message:
                "src/domain/running/** は AI SDK に依存できません（正式仕様 §1.6, §18）。差し替え口は将来 src/infra/ai/ に置きます。",
            },
            {
              name: "@google-cloud/aiplatform",
              message:
                "src/domain/running/** は AI SDK に依存できません（正式仕様 §1.6, §18）。差し替え口は将来 src/infra/ai/ に置きます。",
            },
            {
              name: "cohere-ai",
              message:
                "src/domain/running/** は AI SDK に依存できません（正式仕様 §1.6, §18）。差し替え口は将来 src/infra/ai/ に置きます。",
            },
          ],
          patterns: [
            {
              group: ["next", "next/*"],
              message:
                "src/domain/running/** は Next.js に依存できません（正式仕様 §1.6）。",
            },
            {
              group: ["node:*"],
              message:
                "src/domain/running/** は Node.js 組み込みモジュールに依存できません（正式仕様 §1.6）。hash 計算等はテスト側で行ってください。",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
