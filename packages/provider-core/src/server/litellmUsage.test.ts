import { assert, describe, it } from "@effect/vitest";
import type { TurnTokenUsage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { priceLiteLLMTurn, readLiteLLMSpend, readLiteLLMUsage } from "./litellmUsage.ts";

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
  it.effect("reads only the gateway's rates and user budget with server-side bearer auth", () =>
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
                request.url.endsWith("/user/info")
                  ? {
                      user_id: "u1",
                      user_info: {
                        spend: 25,
                        max_budget: 100,
                        budget_reset_at: "2026-12-01T00:00:00Z",
                      },
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
                request.url.endsWith("/user/info")
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

  const day = (date: string, breakdown: Record<string, Record<string, number>>, key: string) => ({
    date,
    metrics: {},
    breakdown: {
      [key]: Object.fromEntries(
        Object.entries(breakdown).map(([name, metrics]) => [name, { metrics }]),
      ),
    },
  });
  const spendClient = (tagStatus: number) =>
    HttpClient.make((request) => {
      const url = Option.getOrThrow(HttpClientRequest.toUrl(request));
      const page = Number(url.searchParams.get("page"));
      if (url.pathname.endsWith("/activity"))
        assert.equal(url.searchParams.get("start_date"), "2026-11-01");
      const body = url.pathname.endsWith("/user/info")
        ? { user_id: "u1", user_info: null }
        : url.pathname.endsWith("/user/daily/activity")
          ? {
              results: [
                day(
                  page === 1 ? "2026-11-02" : "2026-11-03",
                  {
                    "claude-sonnet": {
                      spend: 1.5,
                      api_requests: 3,
                      prompt_tokens: 1000,
                      cache_read_input_tokens: 600,
                      completion_tokens: 50,
                    },
                    idle: { spend: 0, api_requests: 0 },
                  },
                  "models",
                ),
              ],
              metadata: { has_more: page === 1 },
            }
          : {
              results: [
                day("2026-11-02", { "project:x": { spend: 2, api_requests: 4 } }, "entities"),
              ],
            };
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          url.pathname.endsWith("/tag/daily/activity") && tagStatus !== 200
            ? new Response(null, { status: tagStatus })
            : Response.json(body),
        ),
      );
    });

  it.effect("reads every page of daily model spend and the user's tag spend", () =>
    Effect.gen(function* () {
      const spend = yield* readLiteLLMSpend("https://gw", "secret", "2026-11-01", "2026-11-04");
      assert.equal(spend.userId, "u1");
      assert.deepEqual(
        spend.models.map((row) => [row.day, row.name, row.costUsd, row.cacheReadTokens]),
        [
          ["2026-11-02", "claude-sonnet", 1.5, 600],
          ["2026-11-03", "claude-sonnet", 1.5, 600],
        ],
      );
      assert.deepEqual(
        spend.tags?.map((row) => [row.name, row.costUsd, row.requests]),
        [["project:x", 2, 4]],
      );
    }).pipe(Effect.provideService(HttpClient.HttpClient, spendClient(200))),
  );

  it.effect("keeps model spend when the gateway refuses tag spend", () =>
    Effect.gen(function* () {
      const spend = yield* readLiteLLMSpend("https://gw", "secret", "2026-11-01", "2026-11-04");
      assert.lengthOf(spend.models, 2);
      assert.isUndefined(spend.tags);
    }).pipe(Effect.provideService(HttpClient.HttpClient, spendClient(403))),
  );
});
