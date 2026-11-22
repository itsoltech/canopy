import { Effect } from "effect";
import type { Database } from "./consolidation-catalog.ts";
import type { ConsolidationBlocker, ConsolidationInput } from "./consolidation-types.ts";

// Empty source clocks are rebuildable. Keep every populated owner scope, so an unavailable
// referenced worker or bot becomes a review blocker instead of silently losing its notes.
export const populatedMemoryScope = `s.owner_user_id=$1::uuid AND EXISTS (SELECT FROM public.agent_memory_notes n
  WHERE n.owner_user_id=s.owner_user_id AND n.scope_key=s.scope_key)`;

export function rebaseAgentMemory(sql: Database, input: ConsolidationInput) {
  return Effect.gen(function* () {
    // The source key is captured before rebasing the owning project. Notes refer to that
    // original key, while the generated column now holds their destination scope.
    yield* sql`UPDATE pg_temp.cc_agent_memory_notes n SET scope_key=s.scope_key
      FROM pg_temp.cc_agent_memory_scopes s
      WHERE s.__source_key=jsonb_build_array(${input.source.ownerUserId}::text,n.scope_key)::text`;

    // Bots, conversations, routines and turns retain their UUIDs (collisions block import).
    // Preserve a scoped delegation only if its principal moves with it. A missing historical
    // principal must never grant an unrelated target-local principal access to this transcript.
    yield* sql`CREATE TEMP TABLE cc_memory_principals ON COMMIT DROP AS
      SELECT 'conversation:' || r.bot_id::text || ':' || c.id::text AS audience FROM pg_temp.cc_bot_channel_conversations c
        JOIN pg_temp.cc_bot_channel_routes r ON r.id=c.route_id
      UNION ALL SELECT 'routine:' || bot_id::text || ':' || id::text FROM pg_temp.cc_bot_routines
      UNION ALL SELECT 'turn:' || bot_id::text || ':' || id::text FROM pg_temp.cc_bot_turns`;
    yield* sql`CREATE INDEX ON pg_temp.cc_memory_principals(audience)`;

    yield* sql`UPDATE pg_temp.cc_threads t SET memory_audience=
        'legacy:consolidation:' || ${input.source.nodeId} || ':' || encode(sha256(convert_to(t.memory_audience,'UTF8')),'hex')
      WHERE t.memory_audience<>'' AND NOT EXISTS (SELECT FROM pg_temp.cc_memory_principals p WHERE p.audience=t.memory_audience)`;
    yield* sql`UPDATE pg_temp.cc_schedules s SET memory_audience=
        'legacy:consolidation:' || ${input.source.nodeId} || ':' || encode(sha256(convert_to(s.memory_audience,'UTF8')),'hex')
      WHERE s.memory_audience<>'' AND NOT EXISTS (SELECT FROM pg_temp.cc_memory_principals p WHERE p.audience=s.memory_audience)`;

    // An existing target transcript can carry a dangling audience of its own. Importing an
    // identically named source principal would give it access to that unrelated history.
    return yield* sql<ConsolidationBlocker>`SELECT 'threads' AS "table",t.id::text AS key,
      'destination_memory_audience_collision' AS reason FROM public.threads t
      WHERE t.owner_user_id=${input.target.ownerUserId}::uuid AND t.memory_audience<>'' AND EXISTS (
        SELECT FROM pg_temp.cc_memory_principals p WHERE p.audience=t.memory_audience)
      UNION ALL SELECT 'schedules',s.id::text,'destination_memory_audience_collision'
      FROM public.schedules s JOIN public.projects p ON p.id=s.project_id
      WHERE p.owner_user_id=${input.target.ownerUserId}::uuid AND s.memory_audience<>'' AND EXISTS (
        SELECT FROM pg_temp.cc_memory_principals a WHERE a.audience=s.memory_audience)
      ORDER BY key LIMIT 10`;
  });
}
