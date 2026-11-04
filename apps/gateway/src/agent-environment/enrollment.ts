import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { audit } from "./database.ts";

/** Runs inside the enrollment transaction, using only the owner and tags stored on its locked row. */
export function enrollTags(sql: SqlClient.SqlClient, owner: string, workerId: string, tags: string[]) {
  return Effect.gen(function* () {
    yield* sql`INSERT INTO agent_environments (owner_user_id) VALUES (${owner}::uuid) ON CONFLICT DO NOTHING`;
    yield* sql`UPDATE agent_environments SET revision = revision + 1 WHERE owner_user_id = ${owner}::uuid`;
    yield* sql`INSERT INTO worker_environments (worker_id, manual_tags)
      VALUES (${workerId}::uuid, ${tags}::text[])`;

    if (tags.length) yield* audit(sql, owner, "environment.tags.save", workerId);
  });
}
