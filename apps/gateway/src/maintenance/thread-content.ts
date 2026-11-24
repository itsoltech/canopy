import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { pruneThreadBlobs } from "./thread-blobs.ts";

const BATCH = 256;

interface Compaction {
  readonly table: string;
  readonly scope?: string;
  readonly set: string;
  readonly pending: string;
}

// These are SQL identifiers/expressions owned by the implementation, never request input.
const COMPACTIONS: readonly Compaction[] = [
  {
    table: "turns",
    set: "input='{}'::jsonb,usage=NULL,error=NULL,error_code=NULL,interrupt_reason=NULL,resume_reason=NULL,worktree_switch_source_cwd=NULL",
    pending:
      "input<>'{}'::jsonb OR usage IS NOT NULL OR error IS NOT NULL OR error_code IS NOT NULL OR interrupt_reason IS NOT NULL OR resume_reason IS NOT NULL OR worktree_switch_source_cwd IS NOT NULL",
  },
  {
    table: "turn_steers",
    set: "input='{}'::jsonb,reason=NULL,status=CASE WHEN status IN ('pending','accepted') THEN 'dropped' ELSE status END",
    pending: "input<>'{}'::jsonb OR reason IS NOT NULL OR status IN ('pending','accepted')",
  },
  {
    table: "agent_bus_calls",
    scope: "source_thread_id=$1::uuid",
    set: "arguments='{}'::jsonb,result=NULL,error=NULL",
    pending: "arguments<>'{}'::jsonb OR result IS NOT NULL OR error IS NOT NULL",
  },
  {
    table: "interaction_requests",
    set: "request='{}'::jsonb,response=NULL,allowed_by_bot_rule=NULL,status=CASE WHEN status='pending' THEN 'expired' ELSE status END,answered_at=coalesce(answered_at,now()),answer_delivery=CASE WHEN answer_delivery IN ('pending','consumed') THEN 'cancelled' ELSE answer_delivery END",
    pending:
      "request<>'{}'::jsonb OR response IS NOT NULL OR allowed_by_bot_rule IS NOT NULL OR status='pending' OR answer_delivery IN ('pending','consumed')",
  },
  {
    table: "goals",
    set: "objective='',last_reason=NULL,native_state=NULL,error=NULL,error_at=NULL,status=CASE WHEN status='achieved' THEN status ELSE 'cancelled' END,finished_at=coalesce(finished_at,now())",
    pending:
      "objective<>'' OR last_reason IS NOT NULL OR native_state IS NOT NULL OR error IS NOT NULL OR status NOT IN ('achieved','cancelled')",
  },
  {
    table: "schedules",
    set: "prompt='',name='',status=CASE WHEN status='completed' THEN status ELSE 'cancelled' END,next_run_at=NULL,lease_owner=NULL,lease_until=NULL",
    pending:
      "prompt<>'' OR name<>'' OR status IN ('active','paused') OR lease_owner IS NOT NULL OR lease_until IS NOT NULL",
  },
  {
    table: "worker_commands",
    set: "payload=''::bytea,result=NULL,payload_pruned_at=coalesce(payload_pruned_at,now()),status=CASE WHEN status IN ('pending','delivered') THEN 'expired' ELSE status END,completed_at=coalesce(completed_at,now())",
    pending: "octet_length(payload)>0 OR result IS NOT NULL OR status IN ('pending','delivered')",
  },
  {
    table: "thread_message_receipts",
    set: "response=''::bytea",
    pending: "octet_length(response)>0",
  },
  {
    table: "thread_rewinds",
    set: "draft=NULL,error=NULL",
    pending: "draft IS NOT NULL OR error IS NOT NULL",
  },
  {
    table: "connector_executions",
    set: "result=NULL",
    pending: "result IS NOT NULL",
  },
  {
    table: "import_items",
    set: "snapshot='{}'::jsonb,target='{}'::jsonb,base=NULL,error=NULL,warnings='[]'::jsonb,title='',cwd=''",
    pending:
      "snapshot<>'{}'::jsonb OR target<>'{}'::jsonb OR base IS NOT NULL OR error IS NOT NULL OR warnings<>'[]'::jsonb OR title<>'' OR cwd<>''",
  },
  {
    table: "computer_moves",
    scope: "kind='thread' AND item_id=$1::uuid AND owner_user_id=(SELECT owner_user_id FROM threads WHERE id=$1::uuid)",
    set: "payload=NULL,placement='{}'::jsonb,redo='[]'::jsonb,frozen='{}'::jsonb,error='',title=''",
    pending:
      "payload IS NOT NULL OR placement<>'{}'::jsonb OR redo<>'[]'::jsonb OR frozen<>'{}'::jsonb OR error<>'' OR title<>''",
  },
  {
    table: "computer_agent_calls",
    scope:
      "actor_kind='thread' AND actor_id=$1::uuid AND owner_user_id=(SELECT owner_user_id FROM threads WHERE id=$1::uuid)",
    set: "result=NULL,report_status='dropped',detached=true",
    pending: "result IS NOT NULL OR report_status='pending' OR NOT detached",
  },
  {
    table: "pr_check_watches",
    set: "seen='{}'::jsonb,status='ended',end_reason=coalesce(end_reason,'thread_closed'),ended_at=coalesce(ended_at,now())",
    pending: "seen<>'{}'::jsonb OR status='active'",
  },
  {
    table: "github_mutation_receipts",
    set: "parameters='{}'::jsonb,created_pr=NULL,existing_pr=NULL,detail='',state=CASE WHEN state='prepared' THEN 'failed' ELSE state END",
    pending:
      "parameters<>'{}'::jsonb OR created_pr IS NOT NULL OR existing_pr IS NOT NULL OR detail<>'' OR state='prepared'",
  },
  {
    table: "thread_secrets",
    set: "status='revoked',ciphertext=NULL,key_id=NULL,file_path=NULL,label='',description='',placeholder='',name=''",
    pending:
      "ciphertext IS NOT NULL OR key_id IS NOT NULL OR file_path IS NOT NULL OR label<>'' OR description<>'' OR placeholder<>'' OR name<>'' OR status IN ('pending','saved')",
  },
];

const DELETIONS = [
  "background_task_notes",
  "pr_check_notes",
  "thread_visuals",
  "thread_image_publications",
  "thread_transcript_compaction",
  "thread_events",
  "thread_items",
  "worker_event_quarantine",
  "composer_drafts",
  "thread_replication_content_leases",
  "thread_replication_entity_content",
  "thread_replication_snapshot_generations",
  "thread_replication_seed_entities",
  "thread_replication_journal",
  "thread_replication_content",
  "computer_moved_threads",
] as const;

/** Keep relational identities and receipts, remove the payloads that make history expensive. */
export const pruneThreadContent = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    for (const table of DELETIONS) {
      const rows = yield* sql.unsafe(
        `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table}
          WHERE thread_id=$1::uuid LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING 1`,
        [threadId],
      );

      if (rows.length) return rows.length;

      if ((yield* sql.unsafe(`SELECT 1 FROM ${table} WHERE thread_id=$1::uuid LIMIT 1`, [threadId])).length) return 0;
    }

    for (const step of COMPACTIONS) {
      const rows = yield* sql.unsafe(
        `UPDATE ${step.table} SET ${step.set} WHERE ctid IN (SELECT ctid FROM ${step.table}
          WHERE (${step.scope ?? "thread_id=$1::uuid"}) AND (${step.pending})
          LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING 1`,
        [threadId],
      );

      if (rows.length) return rows.length;

      if (
        (yield* sql.unsafe(
          `SELECT 1 FROM ${step.table}
        WHERE (${step.scope ?? "thread_id=$1::uuid"}) AND (${step.pending}) LIMIT 1`,
          [threadId],
        )).length
      )
        return 0;
    }

    const blobs = yield* pruneThreadBlobs(sql, threadId);

    if (blobs) return blobs;

    // A reference locked by another writer is skipped by blob cleanup, rather than completed.
    if (
      (yield* sql`SELECT 1 FROM attachments WHERE thread_id=${threadId}::uuid
      UNION ALL SELECT 1 FROM thread_blobs WHERE thread_id=${threadId}::uuid
      UNION ALL SELECT 1 FROM worker_preview_uploads WHERE thread_scope=${threadId} LIMIT 1`).length
    )
      return 0;

    yield* sql`UPDATE threads SET purge_completed_at=now() WHERE id=${threadId}::uuid`;

    return 1;
  });
