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
  // R12 MenuPlanner の domain/application contract は provider・framework・DB から独立した純粋境界。
  {
    files: [
      "src/domain/menu-planner/**/*.ts",
      "src/domain/menu-planner/**/*.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              message: "MenuPlanner contract は React に依存できません。",
            },
            {
              name: "react-dom",
              message: "MenuPlanner contract は React に依存できません。",
            },
            {
              name: "@prisma/client",
              message: "MenuPlanner contract は Prisma に依存できません。",
            },
            {
              name: "openai",
              message: "MenuPlanner contract は provider SDK に依存できません。",
            },
            {
              name: "@anthropic-ai/sdk",
              message: "MenuPlanner contract は provider SDK に依存できません。",
            },
            {
              name: "@google/generative-ai",
              message: "MenuPlanner contract は provider SDK に依存できません。",
            },
            {
              name: "@google-cloud/aiplatform",
              message: "MenuPlanner contract は provider SDK に依存できません。",
            },
            {
              name: "cohere-ai",
              message: "MenuPlanner contract は provider SDK に依存できません。",
            },
          ],
          patterns: [
            {
              group: ["next", "next/*", "@/infra/**", "@/actions/**"],
              message:
                "MenuPlanner contract は Next.js・infra・actions に依存できません。",
            },
            {
              group: ["node:*"],
              message:
                "MenuPlanner contract は Node.js 組み込みモジュールに依存できません。",
            },
            {
              regex: "(^|/)(infra|actions)(/|$)",
              message:
                "MenuPlanner contract は相対パス経由でも infra・actions に依存できません。",
            },
            {
              regex: "(^|/)domain/ai(/|$)",
              message:
                "MenuPlanner contract は video AI contract を import できません。",
            },
          ],
        },
      ],
    },
  },
  // Running Prescription Engine v2 — CoachActor / Coach 専用 Server Action の AI 境界（R10-B1 §7・R10-B4A.1）:
  // AI 経路（動画解析・下書き生成・将来の MenuPlanner）は CoachActor を生成できず、CoachActor を内部で生成する
  // Coach 専用の application module（running-actions.ts / _running-plan-service.ts）も**モジュールごと** import できない。
  // 認可判定の唯一の server boundary は src/actions/_actor.ts の getCoachActorForServer()。
  // - paths: alias（@/...）での import を名前付きで禁止（R10-B1）
  // - patterns（regex）: alias・相対パス（../../actions/running-actions 等）・拡張子付きの迂回も同じく禁止（R10-B4A.1）
  // src/actions/** 全体は禁止しない（AI が将来使う安全な proposal / application port を壊さない）。
  // dynamic import() はこのルールの対象外のため、tests/actions/running/ai-coach-boundary.test.ts のソース監査で補う。
  {
    files: [
      "src/domain/ai/**/*.ts",
      "src/domain/ai/**/*.tsx",
      "src/domain/menu-planner/**/*.ts",
      "src/domain/menu-planner/**/*.tsx",
      "src/infra/ai/**/*.ts",
      "src/infra/ai/**/*.tsx",
      "src/app/ai/**/*.ts",
      "src/app/ai/**/*.tsx",
      "src/actions/ai/**/*.ts",
      "src/actions/ai/**/*.tsx",
      "src/actions/ai-*.ts",
      "src/actions/ai-*.tsx",
      "src/actions/_ai-*.ts",
      "src/actions/_ai-*.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/actions/_actor",
              message:
                "AI モジュールは CoachActor を生成できません（R10-B1 §7 の server boundary）。",
            },
            {
              name: "@/domain/running/types/actor",
              importNames: ["createCoachActor", "coachActorSchema"],
              message:
                "AI モジュールは CoachActor を生成できません（createCoachActor / coachActorSchema は禁止）。",
            },
            {
              name: "@/domain/running",
              importNames: ["createCoachActor", "coachActorSchema"],
              message:
                "AI モジュールは CoachActor を生成できません（createCoachActor / coachActorSchema は禁止。root からの re-export 経由も禁止）。",
            },
          ],
          patterns: [
            {
              regex: "(^|/)running-actions(\\.[cm]?[jt]sx?)?$",
              message:
                "AI モジュールは Coach 専用の running-actions を import できません（R10-B4A.1。CoachActor・coachEdits・overrides・allowAdvancedMethods を扱う Coach の信頼境界。R12 の AI 処方は AI actor 専用の application path を使う）。",
            },
            {
              regex: "(^|/)_running-plan-service(\\.[cm]?[jt]sx?)?$",
              message:
                "AI モジュールは Coach 専用の _running-plan-service を import できません（内部で CoachActor を生成する。R10-B4A.1）。",
            },
            {
              regex: "(^|/)_actor(\\.[cm]?[jt]sx?)?$",
              message:
                "AI モジュールは CoachActor を生成できません（_actor は相対パスでも import 禁止。R10-B1 §7・R10-B4A.1）。",
            },
            {
              regex: "(^|/)types/actor(\\.[cm]?[jt]sx?)?$",
              importNames: ["createCoachActor", "coachActorSchema", "CoachActor"],
              message:
                "AI モジュールは CoachActor の生成関数・schema・型を import できません（相対パスでも禁止。R10-B4A.1）。",
            },
            {
              regex: "(^|/)running(/index(\\.[cm]?[jt]sx?)?)?$",
              importNames: ["createCoachActor", "coachActorSchema", "CoachActor"],
              message:
                "AI モジュールは CoachActor の生成関数・schema・型を root re-export 経由でも import できません（相対パスでも禁止。R10-B4A.1）。",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
