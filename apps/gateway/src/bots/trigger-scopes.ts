import type { ScopeKind, TriggerFilter } from "@canopy/domain/bot-triggers";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid } from "../store/errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The owner's live resources of one kind among `ids`, with the names shown in descriptions. */
export function visibleResources(
  sql: SqlClient.SqlClient,
  owner: string,
  kind: ScopeKind,
  ids: readonly string[],
  /** Checking an event that already happened: a schedule may have finished since. */
  reported = false,
) {
  const uuids = ids.filter((id) => UUID.test(id));

  switch (kind) {
    case "project":
      return sql<{ id: string; name: string }>`SELECT id::text, name FROM projects
        WHERE id = ANY(${uuids}::uuid[]) AND owner_user_id = ${owner}::uuid AND archived_at IS NULL`;
    case "worker":
      return sql<{ id: string; name: string }>`SELECT id::text, name FROM workers
        WHERE id = ANY(${uuids}::uuid[]) AND (owner_user_id = ${owner}::uuid OR owner_user_id IS NULL)
          AND revoked_at IS NULL AND archived_at IS NULL`;
    case "thread":
      return sql<{ id: string; name: string }>`SELECT id::text, coalesce(nullif(title, ''), 'Untitled thread') AS name
        FROM threads WHERE id = ANY(${uuids}::uuid[]) AND owner_user_id = ${owner}::uuid
          AND deleted_at IS NULL AND moved_to IS NULL AND memory_audience NOT LIKE 'conversation:%'`;
    case "schedule":
      return sql<{ id: string; name: string }>`SELECT s.id::text, coalesce(nullif(s.name, ''), 'Schedule') AS name
        FROM schedules s JOIN projects p ON p.id = s.project_id
        WHERE s.id = ANY(${uuids}::uuid[]) AND p.owner_user_id = ${owner}::uuid
          AND (${reported} OR s.status IN ('active', 'paused')) AND s.memory_audience NOT LIKE 'conversation:%'`;
    case "repository":
      return sql<{ id: string; name: string }>`SELECT DISTINCT repository_name AS id, repository_name AS name
        FROM github_pull_requests WHERE owner_user_id = ${owner}::uuid AND repository_name = ANY(${[...ids]}::text[])`;
    case "pull_request":
      return sql<{ id: string; name: string }>`SELECT id::text, repository_name || ' #' || number AS name
        FROM github_pull_requests WHERE id = ANY(${uuids}::uuid[]) AND owner_user_id = ${owner}::uuid`;
    case "profile":
      // Profiles are keyed by harness and id; only native ones report usage.
      return sql<{ id: string; name: string }>`SELECT harness || '/' || id AS id, label AS name FROM provider_instances
        WHERE harness || '/' || id = ANY(${[...ids]}::text[]) AND (created_by = ${owner}::uuid OR created_by IS NULL)
          AND kind = 'native' AND proxy_id IS NULL`;
  }
}

/**
 * Every resource in the filter must be the owner's and live now; returns names by id for the description.
 * The message names the kind, so the bot can look the ids up again.
 */
export function checkTriggerScope(sql: SqlClient.SqlClient, owner: string, filter: TriggerFilter) {
  return Effect.gen(function* () {
    const names: Record<string, string> = {};

    for (const [kind, ids] of Object.entries(filter.scope)) {
      // SAFETY: scope keys are scope kinds, validated when the filter was parsed.
      const found = yield* visibleResources(sql, owner, kind as ScopeKind, ids);
      const known = new Set(found.map((row) => row.id));
      const missing = ids.filter((id) => !known.has(id));

      if (missing.length)
        return yield* Effect.fail(
          new Invalid(`Unknown or unavailable ${kind} ids: ${missing.join(", ")}. List them again and use their ids.`),
        );

      for (const row of found) names[row.id] = row.name;
    }

    return names;
  });
}

/** Scope rows exist only while the trigger can match. */
export function writeTriggerScopes(
  sql: SqlClient.SqlClient,
  owner: string,
  trigger: { id: string; event: string; filter: TriggerFilter; live: boolean },
) {
  return Effect.gen(function* () {
    yield* sql`DELETE FROM bot_trigger_scopes WHERE trigger_id = ${trigger.id}::uuid`;

    if (!trigger.live) return;

    for (const [kind, ids] of Object.entries(trigger.filter.scope))
      for (const id of ids)
        yield* sql`INSERT INTO bot_trigger_scopes(trigger_id, owner_user_id, event, kind, ref_id)
          VALUES (${trigger.id}::uuid, ${owner}::uuid, ${trigger.event}, ${kind}, ${id}) ON CONFLICT DO NOTHING`;
  });
}
