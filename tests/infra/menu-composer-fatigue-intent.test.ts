import { describe, expect, it, vi } from "vitest";
import { composeMenuWithOpenAI } from "@/infra/menu-composition/openai-composer";
import { catalogFixture, catalogPlan } from "../fixtures/menu-composition";

const requestText = "高校生100m。来週末に大会。少し疲労をためたい。現在の疲労は1/10。75分のメニューを作ってください。";
const output = {
  overview: { title: "100mの練習", objective: "希望に沿った構成案", approach: "既定の走処方を保ち、登録種目から補助を選びます" },
  transitionSeconds: null,
  blocks: [{ name: "動きづくり", phase: "WARM_UP", allocatedSeconds: 600, items: [catalogPlan()] }],
};

describe("composer preserves unsupported fatigue intent without changing Running authority", () => {
  it("sends the original wish and instructions without reversing it into a prohibition", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] },
    ] }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await composeMenuWithOpenAI({
      requestText,
      context: { ageGroup: "HIGH_SCHOOL", event: "100m", availableTimeSeconds: 4500 },
      catalog: [catalogFixture()],
      runningPrescription: null,
      unsupportedIntents: ["疲労蓄積の希望（走数値には未反映）"],
    }, { apiKey: "offline-fake-key", fetchImpl });

    expect(result).toEqual({ ok: true, value: output });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { instructions: string; input: string };
    expect(body.instructions).toContain("unsupportedIntentsはRunning intentとして走の数値へ反映されなかった希望の一覧であり、その希望を禁止・否定する指示ではない。");
    expect(body.instructions).toContain("「疲労をためたい」を「疲労をためないことを目的にする」と書き換えない。");
    expect(body.instructions).toContain("既存runningPrescriptionの数値をそのまま保ち");
    expect(body.instructions).toContain("大会が近いというだけで調整期・回復期と推定しない。");
    expect(body.instructions).toContain("allocatedSecondsは項目ごとの実所要時間が不明でも、既知の休息・動きの構成・合理的な進行前提があればブロックの計画目安として提案できる。");
    expect(body.instructions).toContain("走ブロックはrunningPrescriptionの既知の実施・休息時間を下回らない計画目安にし、希望時間との差を埋めるため残り時間を全て走へ割り当てない。");
    expect(body.instructions).toContain("defaultが未設定でも今回の編集可能な量を提案してよい。");

    const sentInput = JSON.parse(body.input) as { requestText: string; unsupportedIntents: string[]; context: { availableTimeSeconds: number } };
    expect(sentInput).toMatchObject({ requestText, unsupportedIntents: ["疲労蓄積の希望（走数値には未反映）"],
      context: { ageGroup: "HIGH_SCHOOL", event: "100m", availableTimeSeconds: 4500 } });
  });
});
