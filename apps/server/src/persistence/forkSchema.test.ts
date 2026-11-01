import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrationsWithForkSchema } from "./forkSchema.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const seedRenumberedHistory = (upstreamHead: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: upstreamHead });
    yield* sql`
      ALTER TABLE scheduled_tasks ADD COLUMN request_tags_json TEXT NOT NULL DEFAULT '[]'
    `;
    yield* sql`UPDATE effect_sql_migrations SET migration_id = 76 WHERE migration_id = 75`;
    yield* sql`UPDATE effect_sql_migrations SET migration_id = 75 WHERE migration_id = 74`;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (74, 'ScheduledTaskRequestTags')
    `;
  });

const assertUpstreamHistoryWithForkSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  assert.deepStrictEqual(
    history.map(({ migration_id, name }) => `${migration_id}_${name}`),
    migrationManifest.map(([id, name]) => `${id}_${name}`),
  );
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  assert.isTrue(columns.some(({ name }) => name === "request_tags_json"));
});

describe("fork schema", () => {
  it.effect("adds fork columns to a new database without using a migration id", () =>
    Effect.gen(function* () {
      yield* runMigrationsWithForkSchema();
      yield* assertUpstreamHistoryWithForkSchema;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  // Heads 73, 74, and 75 are the histories of v0.1.8, v0.1.10, and fork main before this repair.
  it.effect.each([73, 74, 75])("restores upstream ids over upstream head %i", (upstreamHead) =>
    Effect.gen(function* () {
      yield* seedRenumberedHistory(upstreamHead);
      yield* runMigrationsWithForkSchema();
      yield* assertUpstreamHistoryWithForkSchema;
      yield* runMigrationsWithForkSchema();
      yield* assertUpstreamHistoryWithForkSchema;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
