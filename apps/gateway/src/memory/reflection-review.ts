import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient, Statement } from "effect/sql";
import { Invalid, NotFound } from "../store/errors.ts";
import { SettingsConflict } from "../store/settings.ts";
import { uuid } from "./model.ts";
import { saveNote } from "./mutations.ts";

const SUGGESTION_LIMIT = 50;
const EVIDENCE_LIMIT = 5;
const RULE_LIMIT = 240;

function currentEvidence(
  sql: SqlClient.SqlClient,
  owner: string,
  habitId: Statement.Fragment,
  projectId: Statement.Fragment,
) {
  return sql`
    SELECT t.id AS thread_id,t.title,e.message_id,e.family_id,e.created_at
    FROM memory_habit_evidence e JOIN threads t ON t.id=e.thread_id
    JOIN memory_reflection_inputs i ON i.thread_id=e.thread_id AND i.message_id=e.message_id
    WHERE e.habit_id=${habitId} AND t.owner_user_id=${owner}::uuid AND t.project_id=${projectId}
      AND i.author_user_id=t.owner_user_id AND t.deleted_at IS NULL AND t.moved_to IS NULL AND t.memory_audience=''
      AND e.created_at>=now()-interval '60 days'`;
}

interface SuggestionRow {
  id: string;
  revision: number;
  projectId: string;
  projectName: string;
  rule: string;
  evidenceCount: number;
  evidence: { threadId: string; title: string; messageId: string }[];
  suspended: boolean;
  noteRevision: number;
}

export function suggestionsFor(sql: SqlClient.SqlClient, owner: string) {
  return sql<SuggestionRow>`
    SELECT h.id,h.revision,h.project_id AS "projectId",p.name AS "projectName",
      CASE WHEN h.state='suspended' THEN n.body ELSE h.rule END AS rule,
      e.count AS "evidenceCount",e.entries AS evidence,h.state='suspended' AS suspended,
      coalesce(n.revision,0) AS "noteRevision"
    FROM memory_habits h JOIN projects p ON p.id=h.project_id AND p.owner_user_id=h.owner_user_id
    LEFT JOIN agent_memory_notes n ON n.id=h.note_id AND n.owner_user_id=h.owner_user_id
      AND n.scope_key='project:' || h.project_id::text
    CROSS JOIN LATERAL (
      WITH authorized AS MATERIALIZED (${currentEvidence(sql, owner, sql`h.id`, sql`h.project_id`)})
      SELECT count(*)::int AS count,(SELECT count(DISTINCT family_id) FROM authorized) AS families,
        coalesce(jsonb_agg(jsonb_build_object('threadId',thread_id,'title',title,'messageId',message_id) ORDER BY position)
          FILTER (WHERE position<=${EVIDENCE_LIMIT}), '[]'::jsonb) AS entries
      FROM (
        SELECT *,row_number() OVER (ORDER BY created_at DESC,message_id DESC) AS position
        FROM (
          SELECT DISTINCT ON (thread_id) thread_id,title,message_id,created_at FROM authorized
          ORDER BY thread_id,created_at DESC,message_id DESC
        ) recent_per_thread
      ) examples
    ) e
    WHERE h.owner_user_id=${owner}::uuid AND p.kind='project' AND p.archived_at IS NULL AND NOT p.config_deleted
      AND ((h.state='pending' AND e.count>=3 AND e.families>=2) OR (h.state='suspended' AND n.id IS NOT NULL))
    ORDER BY h.updated_at DESC,h.id DESC LIMIT ${SUGGESTION_LIMIT}`;
}

interface LinkedNote {
  id: string;
  title: string;
  body: string;
  revision: number;
}

function linkedNotes(sql: SqlClient.SqlClient, owner: string, habitId: string) {
  // Take the note lock first, as deleting a note locks the linked habit to clear its foreign key.
  return sql<LinkedNote>`SELECT n.id,n.title,n.body,n.revision FROM agent_memory_notes n
    JOIN memory_habits h ON h.note_id=n.id AND h.owner_user_id=n.owner_user_id
    WHERE h.id=${habitId}::uuid AND h.owner_user_id=${owner}::uuid AND h.state='suspended'
      AND n.scope_key='project:' || h.project_id::text
    FOR UPDATE OF n`;
}

function approveHabit(
  sql: SqlClient.SqlClient,
  owner: string,
  habit: { id: string; project_id: string; rule: string },
  input: ui.ResolveMemoryHabitRequest,
  linked: LinkedNote | undefined,
) {
  return Effect.gen(function* () {
    if (linked) {
      if (linked.revision !== input.expectedNoteRevision)
        return yield* Effect.fail(new SettingsConflict("This habit’s note changed. Reload it and try again."));
    } else {
      const evidence = currentEvidence(sql, owner, sql`${habit.id}::uuid`, sql`${habit.project_id}::uuid`);

      const eligible = yield* sql`SELECT 1 FROM (${evidence}) live
        HAVING count(DISTINCT thread_id)>=3 AND count(DISTINCT family_id)>=2`;

      if (!eligible.length)
        return yield* Effect.fail(new SettingsConflict("This suggestion changed. Reload it and try again."));
    }

    const text = input.rule || linked?.body || habit.rule;

    if (linked && text === linked.body) return { rule: linked.body, noteId: linked.id };
    const rule = text.trim().replace(/\s+/gu, " ");

    if (!rule || rule.length > RULE_LIMIT || rule.includes("\0"))
      return yield* Effect.fail(new Invalid(`Use a rule of 1–${RULE_LIMIT} characters.`));

    const title = linked?.title ?? (rule.length <= 160 ? rule : `${Array.from(rule).slice(0, 79).join("").trimEnd()}…`);

    const note = yield* saveNote(
      sql,
      owner,
      { kind: "project", projectId: habit.project_id },
      { title, body: rule },
      linked ? { id: linked.id, expectedRevision: linked.revision } : {},
    );

    return { rule, noteId: note.id };
  });
}

export function resolveHabit(sql: SqlClient.SqlClient, owner: string, input: ui.ResolveMemoryHabitRequest) {
  const id = uuid(input.habitId);

  if (!input.expectedRevision) throw new Invalid("Provide the current suggestion revision.");

  return sql.withTransaction(
    Effect.gen(function* () {
      const [note] = yield* linkedNotes(sql, owner, id);

      const [habit] = yield* sql<{
        id: string;
        project_id: string;
        rule: string;
        revision: number;
        state: string;
        note_id: string | null;
      }>`
        SELECT h.id,h.project_id,h.rule,h.revision,h.state,h.note_id FROM memory_habits h
        JOIN projects p ON p.id=h.project_id AND p.owner_user_id=h.owner_user_id
        WHERE h.id=${id}::uuid AND h.owner_user_id=${owner}::uuid AND p.kind='project' AND p.archived_at IS NULL
          AND NOT p.config_deleted
        FOR UPDATE OF h FOR SHARE OF p`;

      if (!habit) return yield* Effect.fail(new NotFound("Habit suggestion not found."));
      const suspended = habit.state === "suspended";
      const linked = suspended && note?.id === habit.note_id ? note : undefined;

      if (
        (!suspended && habit.state !== "pending") ||
        (suspended && !linked) ||
        habit.revision !== input.expectedRevision
      )
        return yield* Effect.fail(new SettingsConflict("This suggestion changed. Reload it and try again."));

      const { rule, noteId } = input.approve
        ? yield* approveHabit(sql, owner, habit, input, linked)
        : { rule: habit.rule, noteId: habit.note_id };

      yield* sql`UPDATE memory_habits SET rule=${rule},state=${input.approve ? "approved" : "rejected"},
        note_id=${noteId}::uuid,revision=revision+1,updated_at=clock_timestamp()
        WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid`;

      return create(EmptySchema);
    }),
  );
}
