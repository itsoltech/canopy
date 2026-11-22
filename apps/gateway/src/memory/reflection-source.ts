import type { Provider } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

export interface ReflectionSettings {
  owner_user_id: string;
  worker_id: string | null;
  project_ids: string[];
  interval_minutes: number;
  provider: Provider;
  profile_id: string;
  model: string;
  effort: string;
  revision: number;
  last_project_id: string | null;
  history_start: Date | null;
}

export interface ReflectionSource {
  project_id: string;
  thread_id: string;
  turn_id: string;
  steer_id: string | null;
  message_id: string;
  family_id: string;
  created_at: Date;
  message: string;
}

/** Read only canonical, delivered inputs. The fork prefix exists in the timeline projection, never here. */
export function reflectionSources(
  sql: SqlClient.SqlClient,
  settings: ReflectionSettings,
  now: Date,
  expected?: readonly ReflectionSource[],
) {
  const owner = settings.owner_user_id;
  const checkIds = expected?.map((source) => source.message_id);

  const sourceFilter = checkIds
    ? sql`AND i.message_id=ANY(${checkIds}::uuid[])`
    : sql`AND NOT EXISTS(SELECT FROM memory_reflection_checked c WHERE c.message_id=i.message_id)`;

  const threadFilter = expected ? sql`AND t.id=ANY(${expected.map((s) => s.thread_id)}::uuid[])` : sql``;

  return sql<ReflectionSource>`
    WITH candidates AS MATERIALIZED (
      SELECT t.id AS thread_id,t.project_id,m.*
      FROM projects p JOIN threads t ON t.project_id=p.id AND t.owner_user_id=p.owner_user_id
      CROSS JOIN LATERAL (
        SELECT i.message_id,i.turn_id,i.steer_id,i.created_at
        FROM memory_reflection_inputs i WHERE i.thread_id=t.id AND i.author_user_id=t.owner_user_id
          AND i.created_at BETWEEN greatest(coalesce(${settings.history_start}::timestamptz,${now}::timestamptz-interval '30 days'),
                                  ${now}::timestamptz-interval '60 days') AND ${now}
          AND NOT i.input ?| ARRAY['shellCommand','shellInputId','shellResult','sourceKind','sender']
          ${sourceFilter} ORDER BY i.created_at,i.message_id LIMIT 4
      ) m
      WHERE t.owner_user_id=${owner}::uuid AND t.project_id=ANY(${settings.project_ids}::uuid[])
        AND p.kind='project' AND NOT p.config_deleted AND p.archived_at IS NULL
        AND t.memory_audience='' AND t.moved_to IS NULL AND t.deleted_at IS NULL AND t.purged_at IS NULL
        AND NOT EXISTS(SELECT FROM thread_imports x WHERE x.thread_id=t.id) AND t.rewind_pending_id IS NULL ${threadFilter}
        AND NOT EXISTS(SELECT FROM turns a WHERE a.thread_id=t.id AND a.status IN ('queued','running'))
        AND NOT EXISTS(SELECT FROM thread_items b WHERE b.thread_id=t.id AND b.type='background_task' AND b.status='in_progress')
        AND (t.archived_at IS NOT NULL OR (
          NOT EXISTS(SELECT FROM turns u WHERE u.thread_id=t.id AND u.author_user_id=t.owner_user_id AND u.trigger='user'
            AND u.queued_at>${now}::timestamptz-interval '7 days' AND u.rewind_id IS NULL AND u.withdrawn IS NULL)
          AND NOT EXISTS(SELECT FROM turn_steers s WHERE s.thread_id=t.id AND s.author_user_id=t.owner_user_id
            AND s.created_at>${now}::timestamptz-interval '7 days' AND s.status IN ('pending','accepted','delivered','queued'))))
    ), picked AS (
      SELECT project_id FROM candidates GROUP BY project_id
      ORDER BY (project_id<=${settings.last_project_id}::uuid) NULLS FIRST, project_id LIMIT 1
    ), batch AS (
      SELECT c.* FROM candidates c JOIN picked USING(project_id) ORDER BY c.created_at,c.message_id LIMIT 96
    )
    SELECT b.*,f.id AS family_id,
      CASE WHEN octet_length(original.message)<=8192 THEN original.message ELSE '' END AS message
    FROM batch b JOIN memory_reflection_inputs i USING(message_id,thread_id)
    CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(i.input->'message')='string' THEN i.input->>'message'
      WHEN i.input - ARRAY['humanAuthored','text','admittedAfterSeq']='{}'::jsonb AND jsonb_typeof(i.input->'text')='string'
      THEN i.input->>'text' END AS message) original
    CROSS JOIN LATERAL (
      WITH RECURSIVE ancestors(id,parent) AS (
        SELECT t.id,coalesce(t.fork_source_thread_id,t.parent_thread_id) FROM threads t WHERE t.id=b.thread_id
        UNION
        SELECT p.id,coalesce(p.fork_source_thread_id,p.parent_thread_id) FROM ancestors a
          JOIN threads p ON p.id=a.parent AND p.owner_user_id=${owner}::uuid
      ) SELECT id FROM ancestors WHERE parent IS NULL
    ) f ORDER BY b.created_at,b.message_id`;
}

export function checkSources(
  sql: SqlClient.SqlClient,
  settings: ReflectionSettings,
  now: Date,
  expected: ReflectionSource[],
) {
  return Effect.gen(function* () {
    const threadIds = [...new Set(expected.map((source) => source.thread_id))].sort();
    // Serializes with SendMessage, archive, retention and rewind during reservation and result application.
    yield* sql`SELECT id FROM threads WHERE owner_user_id=${settings.owner_user_id}::uuid AND id=ANY(${threadIds}::uuid[])
      ORDER BY id FOR SHARE`;
    const live = yield* reflectionSources(sql, settings, now, expected);
    const byId = new Map(live.map((s) => [s.message_id, s]));

    return expected.every((source) => {
      const row = byId.get(source.message_id);

      return (
        row?.message === source.message &&
        row.family_id === source.family_id &&
        row.project_id === source.project_id &&
        row.turn_id === source.turn_id &&
        +row.created_at === +source.created_at
      );
    });
  });
}

export function recordSources(
  sql: SqlClient.SqlClient,
  owner: string,
  sources: readonly ReflectionSource[],
  runId: string | null,
) {
  if (!sources.length) return Effect.void;

  return sql`INSERT INTO memory_reflection_checked(message_id,thread_id,turn_id,steer_id,owner_user_id,run_id)
    SELECT s.message_id,s.thread_id,s.turn_id,s.steer_id,${owner}::uuid,${runId}::uuid
    FROM jsonb_to_recordset(${JSON.stringify(
      sources.map(({ message_id, thread_id, turn_id, steer_id }) => ({ message_id, thread_id, turn_id, steer_id })),
    )}::jsonb) s(message_id uuid,thread_id uuid,turn_id uuid,steer_id uuid)
    ON CONFLICT DO NOTHING`.pipe(Effect.asVoid);
}
