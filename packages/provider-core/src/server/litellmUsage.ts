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
const UserInfo = Schema.Struct({
  user_id: Schema.optional(Schema.NullOr(Schema.String)),
  user_info: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        spend: Money,
        max_budget: Schema.optional(Schema.NullOr(Money)),
        budget_reset_at: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const Count = Schema.optional(Schema.Number);
const Metrics = Schema.Struct({
  spend: Count,
  prompt_tokens: Count,
  completion_tokens: Count,
  cache_read_input_tokens: Count,
  cache_creation_input_tokens: Count,
  api_requests: Count,
});
const Breakdown = Schema.optional(
  Schema.Record(Schema.String, Schema.Struct({ metrics: Metrics })),
);
const DailyActivity = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      date: Schema.String,
      metrics: Metrics,
      breakdown: Schema.optional(Schema.Struct({ models: Breakdown, entities: Breakdown })),
    }),
  ),
  metadata: Schema.optional(Schema.Struct({ has_more: Schema.optional(Schema.Boolean) })),
});
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfo);
const decodeModelInfo = Schema.decodeUnknownEffect(ModelInfo);
const decodeDailyActivity = Schema.decodeUnknownEffect(DailyActivity);

export interface LiteLLMUsage {
  readonly limits: ServerProviderUsageLimits;
  readonly rates: ReadonlyMap<string, typeof Rates.Type>;
}

/** One day and model or tag of gateway spend; days are the gateway's UTC days. */
export interface LiteLLMSpend {
  readonly day: string;
  readonly name: string;
  readonly costUsd: number;
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export interface LiteLLMGatewaySpend {
  readonly userId: string;
  readonly models: ReadonlyArray<LiteLLMSpend>;
  /**
   * Undefined when the gateway refuses or omits tag spend. LiteLLM scopes it to stored keys, and
   * OAuth sign-ins bill each refreshed access token as a new key, so their tag spend reads empty.
   */
  readonly tags: ReadonlyArray<LiteLLMSpend> | undefined;
}

const MAX_ACTIVITY_PAGES = 20;
const count = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;

const makeGet = Effect.fnUntraced(function* (baseUrl: string, token: string) {
  const client = yield* HttpClient.HttpClient;
  return Effect.fn("LiteLLM.getUsageResource")(function* (
    path: string,
    params: Record<string, string> = {},
  ) {
    const response = yield* client.execute(
      HttpClientRequest.get(`${baseUrl.replace(/\/+$/, "")}${path}`).pipe(
        HttpClientRequest.setUrlParams(params),
        HttpClientRequest.bearerToken(token),
      ),
    );
    return yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap((response) => response.json),
    );
  }, Effect.timeout("10 seconds"));
});

/** Flattens `/…/daily/activity` pages into one row per day and breakdown key. */
function flattenLiteLLMActivity(
  pages: ReadonlyArray<typeof DailyActivity.Type>,
  breakdown: "models" | "entities",
): LiteLLMSpend[] {
  const rows: LiteLLMSpend[] = [];
  for (const page of pages) {
    for (const result of page.results) {
      for (const [name, { metrics }] of Object.entries(result.breakdown?.[breakdown] ?? {})) {
        const costUsd = count(metrics.spend);
        const requests = count(metrics.api_requests);
        if (costUsd === 0 && requests === 0) continue;
        rows.push({
          day: result.date.slice(0, 10),
          name,
          costUsd,
          requests: Math.trunc(requests),
          promptTokens: Math.trunc(count(metrics.prompt_tokens)),
          completionTokens: Math.trunc(count(metrics.completion_tokens)),
          cacheReadTokens: Math.trunc(count(metrics.cache_read_input_tokens)),
          cacheCreationTokens: Math.trunc(count(metrics.cache_creation_input_tokens)),
        });
      }
    }
  }
  return rows;
}

/**
 * Reads the signed-in user's gateway spend for UTC days `startDay`..`endDay`. Internal users
 * see only their own keys, so tag spend covers only their requests.
 */
export const readLiteLLMSpend = Effect.fn("LiteLLM.readSpend")(function* (
  baseUrl: string,
  token: string,
  startDay: string,
  endDay: string,
) {
  const get = yield* makeGet(baseUrl, token);
  const activity = Effect.fn("LiteLLM.readActivity")(function* (path: string) {
    const pages: Array<typeof DailyActivity.Type> = [];
    for (let page = 1; page <= MAX_ACTIVITY_PAGES; page++) {
      const result = yield* get(path, {
        start_date: startDay,
        end_date: endDay,
        page: String(page),
        page_size: "1000",
      }).pipe(Effect.flatMap(decodeDailyActivity));
      pages.push(result);
      if (result.metadata?.has_more !== true) break;
    }
    return pages;
  });
  const [user, models, tags] = yield* Effect.all(
    [
      get("/user/info").pipe(Effect.flatMap(decodeUserInfo)),
      activity("/user/daily/activity"),
      activity("/tag/daily/activity").pipe(Effect.option),
    ],
    { concurrency: 3 },
  );
  return {
    userId: user.user_id?.trim() || "unknown",
    models: flattenLiteLLMActivity(models, "models"),
    tags: Option.match(tags, {
      onNone: () => undefined,
      onSome: (pages) => {
        const rows = flattenLiteLLMActivity(pages, "entities");
        return rows.length === 0 ? undefined : rows;
      },
    }),
  } satisfies LiteLLMGatewaySpend;
});

export const readLiteLLMUsage = Effect.fn("LiteLLM.readUsage")(function* (
  baseUrl: string,
  token: string,
  checkedAt: string,
) {
  const get = yield* makeGet(baseUrl, token);
  const [user, models] = yield* Effect.all(
    [
      get("/user/info").pipe(Effect.flatMap(decodeUserInfo), Effect.option),
      get("/model/info").pipe(Effect.flatMap(decodeModelInfo), Effect.option),
    ],
    { concurrency: 2 },
  );
  const info = Option.getOrUndefined(user)?.user_info ?? undefined;
  const reset = info?.budget_reset_at;
  const resetsAt = reset
    ? Option.getOrUndefined(Option.map(DateTime.make(reset), DateTime.formatIso))
    : undefined;
  const limits =
    info === undefined
      ? makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Could not read your LiteLLM budget.",
        })
      : makeUsageLimits({
          checkedAt,
          windows:
            info.max_budget == null
              ? []
              : [
                  {
                    id: "litellm-user-budget",
                    kind: "other",
                    label: `LiteLLM budget ($${info.spend.toFixed(2)} / $${info.max_budget.toFixed(2)})`,
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
