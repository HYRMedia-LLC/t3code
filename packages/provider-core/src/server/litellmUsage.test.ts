import { assert, describe, it } from "@effect/vitest";
import type { TurnTokenUsage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { priceLiteLLMTurn, readLiteLLMUsage } from "./litellmUsage.ts";

const checkedAt = "2026-11-07T12:00:00.000Z";
const rates = {
  input_cost_per_token: 0.000002,
  output_cost_per_token: 0.00001,
  cache_read_input_token_cost: 0.0000002,
  cache_creation_input_token_cost: 0.0000025,
};
const usage: TurnTokenUsage = {
  usageScope: "main_agent",
  usageStatus: "complete",
  hasSubagents: false,
  models: ["private-model"],
  inputTokens: 1000,
  cachedInputTokens: 200,
  cacheCreationTokens: 100,
  outputTokens: 100,
};

describe("LiteLLM usage", () => {
  it.effect("reads only the gateway's rates and key budget with server-side bearer auth", () =>
    Effect.gen(function* () {
      const result = yield* readLiteLLMUsage("https://gateway.example/proxy/", "secret", checkedAt);
      assert.equal(result.limits.windows[0]?.usedPercent, 25);
      assert.equal(result.limits.windows[0]?.resetsAt, "2026-12-01T00:00:00.000Z");
      assert.include(result.limits.windows[0]!.label, "$25.00 / $100.00");
      assert.closeTo(priceLiteLLMTurn(usage, result.rates)!, 0.00269, 1e-10);
      assert.notInclude(JSON.stringify(result), "secret");
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          assert.equal(request.headers.authorization, "Bearer secret");
          assert.notInclude(request.url, "secret");
          assert.isTrue(request.url.startsWith("https://gateway.example/proxy/"));
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                request.url.endsWith("/key/info")
                  ? {
                      info: { spend: 25, max_budget: 100, budget_reset_at: "2026-12-01T00:00:00Z" },
                    }
                  : { data: [{ model_name: "private-model", model_info: rates }] },
              ),
            ),
          );
        }),
      ),
    ),
  );

  it.effect(
    "keeps pricing available when budget access fails and drops ambiguous deployments",
    () =>
      Effect.gen(function* () {
        const result = yield* readLiteLLMUsage("https://gateway.example", "secret", checkedAt);
        assert.equal(result.limits.unavailable?.reason, "probeFailed");
        assert.isUndefined(priceLiteLLMTurn(usage, result.rates));
        assert.equal(priceLiteLLMTurn({ ...usage, models: ["free"] }, result.rates), 0);
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url.endsWith("/key/info")
                  ? new Response(null, { status: 403 })
                  : Response.json({
                      data: [
                        ...Array.from({ length: 3 }, () => ({
                          model_name: "private-model",
                          model_info: rates,
                        })),
                        {
                          model_name: "free",
                          model_info: Object.fromEntries(Object.keys(rates).map((key) => [key, 0])),
                        },
                      ],
                    }),
              ),
            ),
          ),
        ),
      ),
  );

  it("does not substitute public rates or price incomplete and mixed-model usage", () => {
    const prices = new Map([["private-model", rates]]);
    for (const changed of [
      { ...usage, usageStatus: "partial" as const },
      { ...usage, models: ["missing"] },
      { ...usage, models: ["private-model", "other"] },
      { ...usage, localCommand: true },
      { ...usage, inputTokens: 1 },
    ])
      assert.isUndefined(priceLiteLLMTurn(changed, prices));
    assert.isUndefined(
      priceLiteLLMTurn(usage, new Map([["private-model", { input_cost_per_token: 0.1 }]])),
    );
  });
});
