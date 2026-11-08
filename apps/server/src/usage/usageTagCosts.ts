import {
  TurnTokenUsage,
  type UsageSummaryInput,
  type UsageModelSelector,
  type UsageTagCost,
  UsageReadError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { makeDayFormatter } from "./usageAggregation.ts";

const decodeUsage = Schema.decodeUnknownOption(Schema.fromJsonString(TurnTokenUsage));

export const readTagCosts = Effect.fn("UsageService.readTagCosts")(function* (
  input: UsageSummaryInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const since = DateTime.formatIso(
    DateTime.subtract(DateTime.makeUnsafe(`${input.sinceDay}T00:00:00Z`), { hours: 36 }),
  );
  const until = DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe(`${input.untilDay}T00:00:00Z`), { hours: 60 }),
  );
  const rows = yield* sql<{ completed_at: string; driver: string; usage: string }>`
    SELECT t.completed_at, json_extract(p.payload_json, '$.driver') AS driver,
      json_extract(t.payload_json, '$.turnTokenUsage') AS usage
    FROM orchestration_v2_projection_provider_turns t
    JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = t.provider_thread_id
    WHERE t.completed_at >= ${since} AND t.completed_at < ${until}
      AND json_type(t.payload_json, '$.turnTokenUsage.proxyRequestTags') = 'array'
      AND t.status NOT IN ('pending', 'running')
  `.pipe(
    Effect.mapError(
      (cause) =>
        new UsageReadError({ reason: "scanFailed", detail: "Tag usage could not be read.", cause }),
    ),
  );
  const toDay = makeDayFormatter(input.timeZone);
  const totals = new Map<string, UsageTagCost>();
  for (const row of rows) {
    const provider =
      row.driver === "claudeAgent"
        ? "claude"
        : row.driver === "codex"
          ? "codex"
          : row.driver === "opencode"
            ? "opencode"
            : undefined;
    const usage = Option.getOrUndefined(decodeUsage(row.usage));
    if (!provider || !usage || usage.localCommand) continue;
    const date = Option.getOrUndefined(DateTime.make(row.completed_at));
    if (!date) continue;
    const timestamp = DateTime.toEpochMillis(date);
    const day = toDay(timestamp);
    if (day < input.sinceDay || day > input.untilDay) continue;
    if (
      input.resolution === "hour" &&
      (timestamp < Date.parse(input.sinceTime!) || timestamp >= Date.parse(input.untilTime!))
    )
      continue;
    const matches = (selector: UsageModelSelector) =>
      usage.models?.includes(selector.model) &&
      (selector.provider === undefined || selector.provider === provider);
    if (
      input.modelFilter &&
      (!(input.modelFilter.include?.some(matches) ?? true) ||
        input.modelFilter.exclude?.some(matches))
    )
      continue;
    for (const tag of new Set(usage.proxyRequestTags ?? [])) {
      const key = `${provider}:${tag}`;
      const previous = totals.get(key) ?? {
        tag,
        provider,
        costUsd: 0,
        pricedTurns: 0,
        unpricedTurns: 0,
      };
      const cost = usage.proxyCostUsd;
      totals.set(key, {
        ...previous,
        costUsd: previous.costUsd + (cost ?? 0),
        pricedTurns: previous.pricedTurns + (cost === undefined ? 0 : 1),
        unpricedTurns: previous.unpricedTurns + (cost === undefined ? 1 : 0),
      });
    }
  }
  return [...totals.values()].sort((a, b) => b.costUsd - a.costUsd || a.tag.localeCompare(b.tag));
});
