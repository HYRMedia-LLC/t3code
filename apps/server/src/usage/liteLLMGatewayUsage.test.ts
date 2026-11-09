import { describe, expect, it } from "@effect/vitest";
import type { UsageProviderKind } from "@t3tools/contracts";

import { gatewayModelProvider, gatewayRecord, sumGatewayTags } from "./liteLLMGatewayUsage.ts";

const spend = (day: string, name: string, costUsd: number) => ({
  day,
  name,
  costUsd,
  requests: 2,
  promptTokens: 1000,
  completionTokens: 40,
  cacheReadTokens: 700,
  cacheCreationTokens: 100,
});

describe("LiteLLM gateway usage", () => {
  it("attributes gateway models by name alone, so every environment splits spend the same way", () => {
    const cases: Array<[string, UsageProviderKind]> = [
      ["anthropic/claude-sonnet-4-5", "claude"],
      ["gpt-5.5", "codex"],
      ["openai/o3", "codex"],
      ["gemini-2.5-pro", "opencode"],
    ];
    for (const [model, expected] of cases)
      expect(gatewayModelProvider(model), model).toBe(expected);
  });

  it("bills gateway spend as reported cost with cache tokens split out of prompt tokens", () => {
    expect(gatewayRecord(spend("2026-11-02", "gpt-5.5", 1.25), "codex")).toEqual({
      provider: "codex",
      timestampMs: Date.parse("2026-11-02T12:00:00Z"),
      model: "gpt-5.5",
      sessionId: "",
      totals: {
        uncachedInputTokens: 200,
        cachedInputTokens: 700,
        cacheCreationTokens: 100,
        outputTokens: 40,
        reasoningTokens: 0,
      },
      reportedCostUsd: 1.25,
      speed: "standard",
      dedupeKey: null,
    });
  });

  it("sums tag spend across the window's days only", () => {
    expect(
      sumGatewayTags(
        "gw#u1",
        [
          spend("2026-11-01", "project:x", 1),
          spend("2026-11-02", "project:x", 2),
          spend("2026-11-03", "project:x", 4),
        ],
        (day) => day >= "2026-11-02",
      ),
    ).toEqual([{ gateway: "gw#u1", tag: "project:x", costUsd: 6, requests: 4 }]);
  });
});
