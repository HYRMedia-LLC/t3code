import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";

// Fork builds v0.1.8 to v0.1.11 recorded a fork migration at id 74 and moved upstream's ids up by 1.
const restoreUpstreamMigrationIds = Effect.fn("restoreUpstreamMigrationIds")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return;
      const forkRows = yield* sql`
        SELECT 1 FROM effect_sql_migrations
        WHERE migration_id = 74 AND name = 'ScheduledTaskRequestTags'
      `;
      if (forkRows.length === 0) return;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 74`;
      // Move the lower entry first to avoid a primary-key collision.
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 74 WHERE migration_id = 75 AND name = 'ExcludeAttachmentPlaceholdersFromSearch'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 75 WHERE migration_id = 76 AND name = 'SubagentDeliveryState'`;
    }),
  );
});

// Fork schema must stay out of Migrations.ts. A fork id moves upstream's ids and conflicts on each
// sync, and a high id does not help because the migrator skips all ids below the highest recorded.
export const withForkSchema = Effect.fn("withForkSchema")(function* <E, R>(
  migrate: Effect.Effect<unknown, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* restoreUpstreamMigrationIds();
  yield* migrate;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (!columns.some((column) => column.name === "request_tags_json")) {
    yield* sql`
      ALTER TABLE scheduled_tasks
      ADD COLUMN request_tags_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});

export const runMigrationsWithForkSchema = () => withForkSchema(runMigrations());
