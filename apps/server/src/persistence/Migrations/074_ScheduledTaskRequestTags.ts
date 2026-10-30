import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(scheduled_tasks)
  `;
  if (!columns.some((column) => column.name === "request_tags_json")) {
    yield* sql`
      ALTER TABLE scheduled_tasks
      ADD COLUMN request_tags_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
