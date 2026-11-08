import type { ServerProviderUsageLimits, TurnTokenUsage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { makeUnavailableUsageLimits, makeUsageLimits } from "./usageLimits.ts";

const Money = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Rates = Schema.Struct({
  input_cost_per_token: Schema.optional(Schema.NullOr(Money)),
  output_cost_per_token: Schema.optional(Schema.NullOr(Money)),
  cache_read_input_token_cost: Schema.optional(Schema.NullOr(Money)),
  cache_creation_input_token_cost: Schema.optional(Schema.NullOr(Money)),
});
const ModelInfo = Schema.Struct({
  data: Schema.Array(Schema.Struct({ model_name: Schema.String, model_info: Rates })),
});
const KeyInfo = Schema.Struct({
  info: Schema.Struct({
    spend: Money,
    max_budget: Schema.NullOr(Money),
    budget_reset_at: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

export interface LiteLLMUsage {
  readonly limits: ServerProviderUsageLimits;
  readonly rates: ReadonlyMap<string, typeof Rates.Type>;
}

export const readLiteLLMUsage = Effect.fn("LiteLLM.readUsage")(function* (
  baseUrl: string,
  token: string,
  checkedAt: string,
) {
  const client = yield* HttpClient.HttpClient;
  const get = Effect.fn("LiteLLM.getUsageResource")(function* (path: string) {
    const response = yield* client.execute(
      HttpClientRequest.get(`${baseUrl.replace(/\/+$/, "")}${path}`).pipe(
        HttpClientRequest.bearerToken(token),
      ),
    );
    return yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap((response) => response.json),
    );
  }, Effect.timeout("5 seconds"));
  const [key, models] = yield* Effect.all(
    [
      get("/key/info").pipe(Effect.flatMap(Schema.decodeUnknownEffect(KeyInfo)), Effect.option),
      get("/model/info").pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModelInfo)), Effect.option),
    ],
    { concurrency: 2 },
  );
  const info = Option.getOrUndefined(key)?.info;
  const reset = info?.budget_reset_at;
  const resetsAt = reset
    ? Option.getOrUndefined(Option.map(DateTime.make(reset), DateTime.formatIso))
    : undefined;
  const limits =
    info === undefined
      ? makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Could not read the LiteLLM key budget.",
        })
      : makeUsageLimits({
          checkedAt,
          windows:
            info.max_budget === null
              ? []
              : [
                  {
                    id: "litellm-key-budget",
                    kind: "other",
                    label: `LiteLLM key ($${info.spend.toFixed(2)} / $${info.max_budget.toFixed(2)})`,
                    usedPercent:
                      info.max_budget === 0
                        ? 100
                        : Math.min(100, (info.spend / info.max_budget) * 100),
                    ...(resetsAt ? { resetsAt } : {}),
                  },
                ],
        });
  const rates = new Map<string, typeof Rates.Type>();
  const seen = new Set<string>();
  for (const model of Option.getOrUndefined(models)?.data ?? []) {
    // Multiple deployments can bill the same alias at different rates.
    if (seen.has(model.model_name)) rates.delete(model.model_name);
    else rates.set(model.model_name, model.model_info);
    seen.add(model.model_name);
  }
  return { limits, rates } satisfies LiteLLMUsage;
});

export function priceLiteLLMTurn(
  usage: TurnTokenUsage,
  rates: LiteLLMUsage["rates"],
): number | undefined {
  if (usage.usageStatus !== "complete" || usage.localCommand || usage.models?.length !== 1)
    return undefined;
  const rate = rates.get(usage.models[0]!);
  if (!rate) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const created = usage.cacheCreationTokens ?? 0;
  const input = usage.inputTokens - cached - created;
  if (input < 0) return undefined;
  const categories = [
    [input, rate.input_cost_per_token],
    [cached, rate.cache_read_input_token_cost],
    [created, rate.cache_creation_input_token_cost],
    [usage.outputTokens, rate.output_cost_per_token],
  ] as const;
  let cost = 0;
  for (const [tokens, price] of categories) {
    if (tokens === 0) continue;
    if (price == null) return undefined;
    cost += tokens * price;
  }
  return Number.isFinite(cost) ? cost : undefined;
}
