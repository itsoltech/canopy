import { fromJsonString, toJson } from "@bufbuild/protobuf";
import { GitPrContextSchema, type GitPrContext } from "@canopy/contracts";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

export interface DetectionThread {
  thread_id: string;
  worker_id: string;
  cwd: string;
  git_origin: string;
  event_seq: bigint;
  requested: bigint;
  active_until: Date;
  cursors: Schema.JsonObject;
}

export interface ContextRow {
  id: bigint;
  context: Schema.JsonObject;
}

/** Durable scheduling and watermarks are separate from ingest and its ACK transaction. */
export function githubDetectionStore(sql: SqlClient.SqlClient) {
  return {
    detectionCleanupGrant: (owner: string, account: string, worker: string, revision: bigint) => sql`
      SELECT a.id FROM connector_accounts a WHERE a.owner_user_id=${owner}::uuid AND a.id=${account}::uuid
      AND a.connector_type='github' AND a.status='connected' AND a.revision=${revision}::bigint
      AND (a.all_workers OR EXISTS(SELECT 1 FROM connector_worker_grants g WHERE g.account_id=a.id AND g.worker_id=${worker}::uuid))`,
    detectionSeed: (owner: string) => sql`INSERT INTO github_detection_jobs(owner_user_id,thread_id)
      SELECT owner_user_id,id FROM threads WHERE owner_user_id=${owner}::uuid AND worker_id IS NOT NULL
      AND deleted_at IS NULL AND archived_at IS NULL
      ON CONFLICT DO NOTHING`,
    detectionRequest: (
      owner: string,
      id: string,
    ) => sql`INSERT INTO github_detection_jobs(owner_user_id,thread_id,active_until)
      SELECT owner_user_id,id,now()+interval '15 minutes' FROM threads
      WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid AND deleted_at IS NULL AND archived_at IS NULL
      ON CONFLICT(owner_user_id,thread_id) DO UPDATE SET next_at=least(github_detection_jobs.next_at,now()),
      active_until=excluded.active_until,requested=github_detection_jobs.requested+1`,
    detectionClaim: (owner: string, lease: string) => sql<DetectionThread>`WITH due AS (
      SELECT j.thread_id FROM github_detection_jobs j JOIN threads t ON t.owner_user_id=j.owner_user_id AND t.id=j.thread_id
      WHERE j.owner_user_id=${owner}::uuid AND j.next_at<=now() AND (j.lease_until IS NULL OR j.lease_until<now())
      AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.worker_id IS NOT NULL
      ORDER BY j.next_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED
    ) UPDATE github_detection_jobs j SET lease_id=${lease}::uuid,lease_until=now()+interval '2 minutes'
      FROM due,threads t,project_workspaces w WHERE j.owner_user_id=${owner}::uuid AND j.thread_id=due.thread_id
      AND t.id=j.thread_id AND t.owner_user_id=j.owner_user_id AND w.id=t.workspace_id
      RETURNING j.thread_id,t.worker_id,t.cwd,w.git_origin,j.event_seq,j.requested,j.active_until,j.cursors`,
    detectionFinish: (
      owner: string,
      id: string,
      lease: string,
      seq: bigint,
      detail: string,
      cursors: Readonly<Record<string, number>>,
      requested: bigint,
      more: boolean,
    ) =>
      sql`UPDATE github_detection_jobs j SET event_seq=greatest(event_seq,${seq}::bigint),detail=${detail},cursors=${JSON.stringify(cursors)}::jsonb,lease_id=NULL,lease_until=NULL,
      next_at=CASE WHEN requested<>${requested}::bigint OR ${more} THEN now()+interval '1 second'
        WHEN active_until>now() OR EXISTS(SELECT 1 FROM turns u WHERE u.thread_id=j.thread_id AND u.status IN ('running','queued'))
        THEN now()+interval '5 minutes' * (0.8+random()*0.4) ELSE 'infinity'::timestamptz END
      WHERE owner_user_id=${owner}::uuid AND thread_id=${id}::uuid AND lease_id=${lease}::uuid`,
    detectionDetail: (owner: string, id: string) => sql<{ detail: string }>`SELECT detail FROM github_detection_jobs
      WHERE owner_user_id=${owner}::uuid AND thread_id=${id}::uuid`,
    detectionContext: (
      owner: string,
      id: string,
      before = new Date(),
    ) => sql<ContextRow>`SELECT id,context FROM github_git_contexts
      WHERE owner_user_id=${owner}::uuid AND thread_id=${id}::uuid AND observed_at<=${before} ORDER BY id DESC LIMIT 1`,
    detectionSaveContext: (owner: string, id: string, context: GitPrContext) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const previous = (yield* sql<ContextRow>`SELECT id,context FROM github_git_contexts
        WHERE owner_user_id=${owner}::uuid AND thread_id=${id}::uuid ORDER BY id DESC LIMIT 1`)[0];

          const json = JSON.stringify(toJson(GitPrContextSchema, context));

          if (
            previous &&
            JSON.stringify(
              toJson(GitPrContextSchema, fromJsonString(GitPrContextSchema, JSON.stringify(previous.context))),
            ) === json
          )
            return previous;

          const saved = (yield* sql<ContextRow>`INSERT INTO github_git_contexts(owner_user_id,thread_id,context)
        VALUES (${owner}::uuid,${id}::uuid,${json}::jsonb) RETURNING id,context`)[0]!;

          yield* sql`UPDATE threads SET pull_request_revision=pull_request_revision+1 WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid`;

          return saved;
        }),
      ),
    detectionEvents: (owner: string, id: string, seq: bigint) => sql<{
      seq: bigint;
      output_hex: string;
      occurred_at: Date;
    }>`SELECT e.seq,least(e.occurred_at,e.recorded_at) AS occurred_at,encode(substring(convert_to(CASE
      WHEN e.payload#>>'{itemCompleted,item,status}'='ITEM_STATUS_COMPLETED' THEN CASE
        WHEN coalesce(e.payload#>>'{itemCompleted,item,toolCall,isError}','false')='false'
          AND e.payload#>'{itemCompleted,item,toolCall}' IS NOT NULL
          THEN coalesce(e.payload#>>'{itemCompleted,item,toolCall,output}','')
        WHEN coalesce(e.payload#>>'{itemCompleted,item,commandExecution,exitCode}','0')='0'
          AND e.payload#>'{itemCompleted,item,commandExecution}' IS NOT NULL
          THEN coalesce(e.payload#>>'{itemCompleted,item,commandExecution,output}','')
        ELSE '' END ELSE '' END,'UTF8') FOR 65536),'hex') AS output_hex FROM thread_events e
      JOIN threads t ON t.id=e.thread_id WHERE t.owner_user_id=${owner}::uuid AND t.id=${id}::uuid
      AND e.seq>${seq}::bigint AND e.kind IN ('item_completed','turn_finished') ORDER BY e.seq LIMIT 20`,
  };
}
