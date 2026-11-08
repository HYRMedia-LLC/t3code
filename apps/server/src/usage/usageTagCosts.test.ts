import { assert, describe, it } from "@effect/vitest";
import { UsageDay, type TurnTokenUsage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import { readTagCosts } from "./usageTagCosts.ts";

const window = {
  sinceDay: UsageDay.make("2026-11-07"),
  untilDay: UsageDay.make("2026-11-07"),
  timeZone: "UTC",
};
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
    (provider_thread_id, provider, status, updated_at, payload_json)
    VALUES ('provider-thread', 'claudeAgent', 'ready', '2026-11-07T00:00:00.000Z', '{"driver":"claudeAgent"}')`;
  const rows = [
    {
      tags: ["jira:ABC-1", "project:before", "project:before"],
      cost: 1.25,
      time: "2026-11-07T17:00:00.000Z",
    },
    { tags: ["project:after"], cost: 0, time: "2026-11-07T18:00:00.000Z" },
    { tags: ["jira:ABC-1"], time: "2026-11-07T19:00:00.000Z" },
    { tags: ["jira:ABC-1"], cost: 2, time: "2026-11-08T01:00:00.000Z" },
    { tags: ["jira:ABC-1"], cost: 100, time: "2026-11-07T20:00:00.000Z", local: true },
    { tags: ["jira:ABC-1"], cost: 100, time: "2026-11-07T21:00:00.000Z", running: true },
  ];
  for (const [i, row] of rows.entries()) {
    const usage: TurnTokenUsage = {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 10,
      outputTokens: 1,
      models: ["private-model"],
      proxyRequestTags: row.tags,
      ...(row.cost === undefined ? {} : { proxyCostUsd: row.cost }),
      ...(row.local ? { localCommand: true } : {}),
    };
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({ provider_turn_id: `turn-${i}`, thread_id: "thread", provider_thread_id: "provider-thread", node_id: "node", ordinal: i + 1, status: row.running ? "running" : "completed", completed_at: row.time, payload_json: JSON.stringify({ turnTokenUsage: usage }) })}`;
  }
});

describe("tag cost history", () => {
  it.effect(
    "keeps turn tags, counts unpriced usage, deduplicates tags, and uses local date boundaries",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const utc = yield* readTagCosts(window);
        assert.deepEqual(utc, [
          {
            tag: "jira:ABC-1",
            provider: "claude",
            costUsd: 1.25,
            pricedTurns: 1,
            unpricedTurns: 1,
          },
          {
            tag: "project:before",
            provider: "claude",
            costUsd: 1.25,
            pricedTurns: 1,
            unpricedTurns: 0,
          },
          {
            tag: "project:after",
            provider: "claude",
            costUsd: 0,
            pricedTurns: 1,
            unpricedTurns: 0,
          },
        ]);
        const local = yield* readTagCosts({ ...window, timeZone: "America/New_York" });
        assert.equal(local[0]?.costUsd, 3.25);
        assert.equal(local[0]?.pricedTurns, 2);
      }).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect("applies exact hourly bounds and model filters", () =>
    Effect.gen(function* () {
      yield* seed;
      const hourly = yield* readTagCosts({
        ...window,
        resolution: "hour",
        sinceTime: "2026-11-07T17:00:00Z",
        untilTime: "2026-11-07T18:00:00Z",
      });
      assert.equal(hourly.length, 2);
      assert.isTrue(hourly.every((row) => row.costUsd === 1.25 && row.unpricedTurns === 0));
      assert.deepEqual(
        yield* readTagCosts({
          ...window,
          modelFilter: { exclude: [{ provider: "claude", model: "private-model" }] },
        }),
        [],
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );
});
