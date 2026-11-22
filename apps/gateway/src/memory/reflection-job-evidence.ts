import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { reflectionProposals } from "./reflection-prompt.ts";

type Proposal = NonNullable<ReturnType<typeof reflectionProposals>>[number];

export function saveReflectionProposal(
  sql: SqlClient.SqlClient,
  owner: string,
  projectId: string,
  now: Date,
  proposal: Proposal,
) {
  return Effect.gen(function* () {
    if (proposal.signal !== "reversal") {
      yield* sql`INSERT INTO memory_habits(id,owner_user_id,project_id,habit_key,rule,state,updated_at)
        VALUES(${Bun.randomUUIDv7()}::uuid,${owner}::uuid,${projectId}::uuid,${proposal.key},${proposal.rule},'observing',${now})
        ON CONFLICT(owner_user_id,project_id,habit_key) DO NOTHING`;
    }

    const [habit] = yield* sql<{
      id: string;
      state: string;
      reversed_at: Date | null;
      updated_at: Date;
      note_id: string | null;
    }>`
      SELECT h.id,h.state,h.reversed_at,greatest(h.updated_at,n.updated_at) AS updated_at,h.note_id
      FROM memory_habits h LEFT JOIN agent_memory_notes n ON n.id=h.note_id AND n.owner_user_id=h.owner_user_id WHERE h.owner_user_id=${owner}::uuid
        AND h.project_id=${projectId}::uuid AND h.habit_key=${proposal.key} FOR UPDATE OF h`;

    if (!habit || habit.state === "rejected" || (["approved", "suspended"].includes(habit.state) && !habit.note_id))
      return;

    if (proposal.signal === "reversal") {
      const latest = new Date(Math.max(...proposal.evidence.map((s) => s.created_at.getTime())));

      if (habit.reversed_at && latest <= habit.reversed_at) return;

      // Historical requests cannot overrule a subsequent manual approval.
      if (habit.state === "approved" && latest <= habit.updated_at) return;

      const [newer] =
        yield* sql`SELECT FROM memory_habit_evidence WHERE habit_id=${habit.id}::uuid AND created_at>=${latest} LIMIT 1`;

      if (newer) return;
      yield* sql`UPDATE memory_habits SET state=CASE WHEN state IN ('approved','suspended') THEN 'suspended' ELSE 'observing' END,
        reversed_at=${latest},revision=revision+1,updated_at=${now} WHERE id=${habit.id}::uuid`;
      yield* sql`DELETE FROM memory_habit_evidence WHERE habit_id=${habit.id}::uuid`;

      if (!habit.note_id) return;
    } else if (habit.state === "suspended") return;

    for (const source of proposal.evidence) {
      if (habit.reversed_at && source.created_at <= habit.reversed_at) continue;
      yield* sql`INSERT INTO memory_habit_evidence(habit_id,thread_id,message_id,family_id,created_at)
        VALUES(${habit.id}::uuid,${source.thread_id}::uuid,${source.message_id}::uuid,${source.family_id}::uuid,${source.created_at})
        ON CONFLICT DO NOTHING`;
    }

    if (proposal.signal === "reversal") return;
    yield* sql`UPDATE memory_habits SET state='pending',revision=revision+1,updated_at=${now}
      WHERE id=${habit.id}::uuid AND state='observing' AND EXISTS (
        SELECT FROM memory_habit_evidence e WHERE e.habit_id=${habit.id}::uuid AND e.created_at>=${now}::timestamptz-interval '60 days'
          AND (reversed_at IS NULL OR e.created_at>reversed_at)
        HAVING count(DISTINCT thread_id)>=3 AND count(DISTINCT family_id)>=2)`;
  });
}
