import type { StartTurn } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { noteFromRow, type NoteRow } from "./model.ts";
import { MemoryIndex } from "./search.ts";

const MAX_ESTIMATED_TOKENS = 500;
const MAX_CONTEXT_BYTES = 1500;
const MAX_CANDIDATES = 32;
const MAX_RULES = 8;
const MAX_QUERY_CHARACTERS = 2048;

const HEADER =
  "[canopy] Approved project habits. Apply when relevant and consistent with the current user request and permissions:";

const REVOKED = "[canopy] The previously supplied project habits block is revoked. Ignore it.";

const topicPatterns = new Map([
  [
    "ui_changes",
    /\b(?:ui|ux|button|layout|stylesheet|frontend|screenshot|spacing|css|modal)\b|przycisk|interfejs|układ|zrzut ekranu/iu,
  ],
  [
    "code_changes",
    /\b(?:code|fix|implement|refactor|patch|build|typecheck|bug)\b|zaimplementuj|napraw|zrefaktoryzuj/iu,
  ],
  ["task_completion", /\b(?:finish|complete|finalize)\b|dokończ|zakończ/iu],
  ["answering_questions", /\?|^\s*(?:how|why|what|where|when|which|explain|jak|dlaczego|gdzie|kiedy|wyjaśnij)\b/iu],
]);

interface HabitContextRow extends NoteRow {
  query: string;
  habit_key: string;
  habit_id: string;
}

interface HabitContextRule {
  habit_id: string;
  note_id: string;
  note_revision: number;
}

function estimatedTokens(text: string): number {
  let count = 0;

  // Up to three ASCII letters or digits or four horizontal spaces per token. Count other ASCII characters
  // separately and charge each byte of non-ASCII text, including punctuation, emoji and control characters.
  for (const [piece] of text.matchAll(/[a-zA-Z0-9]{1,3}|[ \t]{1,4}|[\s\S]/gu))
    count += piece.charCodeAt(0) <= 0x7f ? 1 : Buffer.byteLength(piece);

  return count;
}

function habitContext(rows: readonly HabitContextRow[], query: string) {
  const pinned = rows.filter((row) => row.pinned);
  const unpinned = rows.filter((row) => !row.pinned);
  const byNoteId = new Map(unpinned.map((row) => [row.id, row]));
  const matches = new MemoryIndex(unpinned.map(noteFromRow)).search([query], MAX_CANDIDATES, true);
  const topical = rows.filter((row) => topicPatterns.get(row.habit_key.split(":", 1)[0] ?? "")?.test(query));
  const ordered = [...pinned, ...matches.flatMap((note) => byNoteId.get(note.id) ?? []), ...topical];
  const included = new Set<string>();
  const rules: HabitContextRule[] = [];
  let context = HEADER;

  for (const rule of ordered) {
    if (included.has(rule.body)) continue;
    const next = `${context}\n- ${JSON.stringify(rule.body)}`;

    // The estimate and byte ceiling include framing and JSON escapes.
    if (Buffer.byteLength(next) > MAX_CONTEXT_BYTES || estimatedTokens(next) > MAX_ESTIMATED_TOKENS) continue;
    context = next;
    included.add(rule.body);
    rules.push({ habit_id: rule.habit_id, note_id: rule.id, note_revision: rule.revision });

    if (rules.length === MAX_RULES) break;
  }

  return { context, rules };
}

function habitTurnScope(
  sql: SqlClient.SqlClient,
  ids: { ownerId: string; workerId: string; threadId: string; turnId: string },
) {
  return sql`
    SELECT t.id, t.owner_user_id, t.project_id,
      left(coalesce(u.input->>'message', u.input->>'text', ''), ${MAX_QUERY_CHARACTERS}) AS query
    FROM threads t
    JOIN turns u ON u.thread_id=t.id AND u.id=${ids.turnId}::uuid
    JOIN projects p ON p.id=t.project_id AND p.owner_user_id=t.owner_user_id
    WHERE t.id=${ids.threadId}::uuid AND t.owner_user_id=${ids.ownerId}::uuid AND t.worker_id=${ids.workerId}::uuid
      AND t.runtime='worker' AND t.origin='user' AND t.memory_audience='' AND t.remote_parent_ref IS NULL
      AND t.fork_source_thread_id IS NULL AND t.archived_at IS NULL AND t.deleted_at IS NULL
      AND t.moved_to IS NULL AND t.rewind_pending_id IS NULL
      AND p.kind='project' AND p.archived_at IS NULL
      AND u.status='queued' AND u.trigger='user' AND u.author_user_id=t.owner_user_id AND u.rewind_id IS NULL
      AND u.input @> '{"humanAuthored":true}' AND u.withdrawn IS NULL
      AND NOT EXISTS (SELECT 1 FROM bot_started_threads b WHERE b.thread_id=t.id)`;
}

function previousContext(
  sql: SqlClient.SqlClient,
  scope: ReturnType<typeof habitTurnScope>,
  threadId: string,
  turnId: string,
) {
  return sql<{ known: boolean; revoked: boolean }>`
    WITH revoked AS (
      UPDATE memory_habit_thread_contexts c SET revoked_turn_id=${turnId}::uuid
      FROM (${scope}) t
      WHERE c.thread_id=t.id AND c.revoked_turn_id IS NULL AND c.turn_id<>${turnId}::uuid
        AND (
          NOT EXISTS (SELECT 1 FROM memory_reflection_settings s
            WHERE s.owner_user_id=t.owner_user_id AND s.enabled AND t.project_id=ANY(s.project_ids))
          OR EXISTS (
            SELECT 1 FROM jsonb_to_recordset(c.rules) rule(habit_id uuid,note_id uuid,note_revision integer)
            WHERE NOT EXISTS (
              SELECT 1 FROM memory_habits h JOIN agent_memory_notes n ON n.id=h.note_id
                AND n.owner_user_id=h.owner_user_id AND n.scope_key='project:' || h.project_id::text
              WHERE h.id=rule.habit_id AND h.owner_user_id=t.owner_user_id AND h.project_id=t.project_id
                AND h.state='approved' AND n.id=rule.note_id AND n.revision=rule.note_revision
            )
          )
        )
      RETURNING c.thread_id
    )
    SELECT EXISTS (SELECT 1 FROM memory_habit_thread_contexts c WHERE c.thread_id=${threadId}::uuid) AS known,
      EXISTS (SELECT 1 FROM revoked) AS revoked`;
}

/** Reserve the initial block or its one revocation before sending. The marker stores only rule identities. */
export function reserveHabitContext(ownerId: string, workerId: string, turn: StartTurn) {
  const thread = turn.profiledThread?.thread ?? turn.thread;

  if (!thread?.enableMemory || thread.hasDelegatingBot || turn.input?.authorUserId !== ownerId)
    return Effect.succeed("");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scope = habitTurnScope(sql, { ownerId, workerId, threadId: thread.threadId, turnId: turn.turnId });
    const [previous] = yield* previousContext(sql, scope, thread.threadId, turn.turnId);

    if (previous?.known) return previous.revoked ? REVOKED : "";

    const rows = yield* sql<HabitContextRow>`
      SELECT n.*, h.id AS habit_id, h.habit_key, t.query
      FROM (${scope}) t
      JOIN memory_reflection_settings s ON s.owner_user_id=t.owner_user_id AND s.enabled AND t.project_id=ANY(s.project_ids)
      JOIN memory_habits h ON h.owner_user_id=t.owner_user_id AND h.project_id=t.project_id AND h.state='approved'
      JOIN agent_memory_notes n ON n.id=h.note_id AND n.owner_user_id=h.owner_user_id
        AND n.scope_key='project:' || t.project_id::text
      WHERE octet_length(n.body)<=${MAX_CONTEXT_BYTES}
      ORDER BY n.pinned DESC, h.updated_at DESC, h.id
      LIMIT ${MAX_CANDIDATES}`;

    if (!rows.length) return "";
    const { context, rules } = habitContext(rows, rows[0]!.query);

    if (!rules.length) return "";

    // Commit the reservation before sending. A lost handoff can omit the block, but can never append it twice.
    const reserved = yield* sql`INSERT INTO memory_habit_thread_contexts (thread_id, turn_id, rules)
      VALUES (${thread.threadId}::uuid, ${turn.turnId}::uuid, ${JSON.stringify(rules)}::jsonb)
      ON CONFLICT (thread_id) DO NOTHING RETURNING thread_id`;

    return reserved.length ? context : "";
  });
}
