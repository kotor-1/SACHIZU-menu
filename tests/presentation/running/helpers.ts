/**
 * R10-B3 presentation テスト用のヘルパー（新しい依存を追加しない）。
 *
 * - `renderMarkup`: react-dom/server の静的レンダリング（既存依存）。
 * - `expandTree`: hooks を持たない関数コンポーネントを直接呼び出して、host 要素（div / button / input …）の
 *   ツリーへ展開する。DOM ライブラリ無しで onClick / onChange の callback を呼ぶために使う。
 * - 内部キー漏れの検査（DOM と DTO の user-facing 文字列）。
 */
import { createElement, isValidElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getRuleSet } from "@/domain/running/rules/loader";
import type { RuleSet } from "@/domain/running/rules/schema";

export function renderMarkup<P extends object>(component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(component, props));
}

export type HostNode = { type: string; props: Record<string, unknown>; children: HostTree[] };
export type HostTree = HostNode | string;

export function expandTree(node: ReactNode): HostTree[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(expandTree);
  if (!isValidElement(node)) return [];
  const props = (node.props ?? {}) as Record<string, unknown>;
  if (typeof node.type === "function") {
    return expandTree((node.type as (p: unknown) => ReactNode)(props));
  }
  if (typeof node.type !== "string") {
    // Fragment 等
    return expandTree(props.children as ReactNode);
  }
  return [{ type: node.type, props, children: expandTree(props.children as ReactNode) }];
}

export function findAll(trees: HostTree[], predicate: (n: HostNode) => boolean): HostNode[] {
  const out: HostNode[] = [];
  const walk = (t: HostTree) => {
    if (typeof t === "string") return;
    if (predicate(t)) out.push(t);
    t.children.forEach(walk);
  };
  trees.forEach(walk);
  return out;
}

export function textOf(tree: HostTree | HostTree[]): string {
  if (Array.isArray(tree)) return tree.map(textOf).join("");
  return typeof tree === "string" ? tree : tree.children.map(textOf).join("");
}

export function buttonByText(trees: HostTree[], text: string): HostNode[] {
  return findAll(trees, (n) => n.type === "button" && textOf(n).includes(text));
}

/** markup からタグを除いたテキスト。 */
export function stripTags(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ");
}

/** 通常 UI に出てはいけない内部キー（明示リスト）。 */
export const FORBIDDEN_RAW_KEYS = [
  "ACCELERATION",
  "MAX_VELOCITY",
  "LONG_SPRINT_RACE_SPECIFIC",
  "SPRINT_ENDURANCE_SHORT",
  "TEMPO_EXTENSIVE",
  "TEMPO_INTENSIVE",
  "RESISTED_SPRINT",
  "ASSISTED_SPRINT",
  "EVENT_APPROACH_SPEED",
  "STRIDE",
  "AGG_TOTAL_RUNNING_CONFIRM",
  "REQUIRE_COACH_REVIEW",
  "REQUIRE_CONFIRMATION",
  "BLOCK_AUTOGEN",
  "POLICY_ONLY",
  "ENGINE_POLICY",
  "RULESET_DRAFT",
] as const;

/** テキストとして出てはいけない単語 enum（語境界で検査）。 */
const FORBIDDEN_WORD_ENUMS = [
  "INFO",
  "WARN",
  "BLOCK",
  "HIGH",
  "MODERATE",
  "LOW",
  "DRAFT",
  "ACTIVE",
  "RETIRED",
  "DIRECT",
  "PARTIAL",
  "INDIRECT",
  "NOT_APPLICABLE",
  "FULL",
  "INCOMPLETE",
  "ENGINE",
  "AI_PLANNER",
  "COACH",
  "LOWER",
  "MIDDLE",
  "DISTANCE",
  "DURATION",
  "SPLIT",
  "ATTEMPTS",
  "MEDIUM",
  "NONE",
  "MAX_INTENT",
  "COACH_EDITABLE",
  "HARD_SAFETY",
  "TEMPLATE_FIXED",
];

const UPPER_SNAKE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g;

/** 検出した内部キーを返す（空配列 = 漏れなし）。markup は属性値も含めて UPPER_SNAKE を検査する。 */
export function rawKeyLeaks(markup: string): string[] {
  const leaks = new Set<string>();
  for (const key of FORBIDDEN_RAW_KEYS) if (markup.includes(key)) leaks.add(key);
  for (const m of markup.match(UPPER_SNAKE) ?? []) leaks.add(m);
  const text = stripTags(markup);
  for (const word of FORBIDDEN_WORD_ENUMS) {
    if (new RegExp(`(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)`).test(text)) leaks.add(word);
  }
  return [...leaks];
}

/** DTO の中で内部値として持ってよいキー（user-facing 文字列の検査から除外する）。 */
export const DTO_INTERNAL_KEYS = new Set([
  "key",
  "id",
  "developerCode",
  "confirmationKey",
  "severitiesInternal",
  "methodInternal",
  "templateIdInternal",
  "keyInternal",
  "layerInternal",
  "ruleIdInternal",
  "fieldInternal",
  "generatedByInternal",
  "tone",
  "prescriptionTone",
  "status",
  "kind",
]);

/** DTO を走査し、user-facing な文字列に含まれる内部キーを返す。 */
export function dtoRawKeyLeaks(dto: unknown): string[] {
  const leaks = new Set<string>();
  const walk = (value: unknown, key: string | null) => {
    if (key !== null && DTO_INTERNAL_KEYS.has(key)) return;
    if (typeof value === "string") {
      for (const l of rawKeyLeaks(value)) leaks.add(`${key}: ${l}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v) => walk(v, key));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(dto, null);
  return [...leaks];
}

export function productionRuleSet(): RuleSet {
  return getRuleSet("rs-2026.09.0")!;
}
