import { toJson } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { MutationRow } from "./store-mutations.ts";
import { lifecycleParameters } from "./lifecycle.ts";

export function githubCreateStore(
  sql: SqlClient.SqlClient,
  audit: (r: MutationRow, outcome: string) => Effect.Effect<ReadonlyArray<object>, Error>,
) {
  return {
    mutationExisting: (r: MutationRow, ref: github.PullRequestRef) =>
      sql<MutationRow>`UPDATE github_mutation_receipts SET existing_pr=${JSON.stringify(toJson(github.PullRequestRefSchema, ref))}::jsonb,
        detail='A pull request already exists for this branch. Review it, then link it to this thread.',updated_at=now()
        WHERE owner_user_id=${r.owner_user_id}::uuid AND request_id=${r.request_id}::uuid AND state='failed' RETURNING *`,
    mutationPrepareCreate: (
      owner: string,
      client: string,
      r: github.PullRequestMutationRequest,
      fingerprint: string,
      mapping: bigint,
      repository: string,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<MutationRow>`INSERT INTO github_mutation_receipts
        (owner_user_id,request_id,account_id,thread_id,repository_id,client_binding,fingerprint,action,access_revision,mapping_revision,head_sha,expected_state,confirmation_id,parameters)
        SELECT ${owner}::uuid,${r.clientRequestId}::uuid,${r.accountId}::uuid,t.id,${repository},${client},${fingerprint},'create_pr',${r.accessRevision}::bigint,${mapping}::bigint,${r.headSha},'',${Bun.randomUUIDv7()}::uuid,${JSON.stringify(lifecycleParameters(r))}::jsonb
        FROM threads t WHERE t.owner_user_id=${owner}::uuid AND t.id=${r.threadId}::uuid AND t.deleted_at IS NULL
        ON CONFLICT DO NOTHING RETURNING *`;

          if (rows[0]) yield* audit(rows[0], "prepared");

          return rows.length
            ? rows
            : yield* sql<MutationRow>`SELECT * FROM github_mutation_receipts WHERE owner_user_id=${owner}::uuid AND request_id=${r.clientRequestId}::uuid`;
        }),
      ),
    // Save GitHub's immutable ID before local linking. A crash here resumes only reads and SQL.
    mutationCreated: (r: MutationRow, ref: github.PullRequestRef) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql<MutationRow>`UPDATE github_mutation_receipts SET state='accepted',created_pr=${JSON.stringify(toJson(github.PullRequestRefSchema, ref))}::jsonb,
        upstream_id=${ref.nodeId},lease_until=NULL,updated_at=now() WHERE owner_user_id=${r.owner_user_id}::uuid AND request_id=${r.request_id}::uuid AND state='in_flight' RETURNING *`;

          if (rows[0]) yield* audit(rows[0], "accepted");

          return rows[0];
        }),
      ),
    mutationLinkCreated: (r: MutationRow, snapshot: github.PullRequestSnapshot) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const ref = snapshot.summary?.ref;

          if (!ref || !r.thread_id) return;

          const rows = yield* sql<MutationRow>`SELECT m.* FROM github_mutation_receipts m
        JOIN github_accounts a ON a.owner_user_id=m.owner_user_id AND a.id=m.account_id AND a.revision=m.access_revision AND a.status='connected'
        JOIN github_repository_accounts ra ON ra.owner_user_id=a.owner_user_id AND ra.account_id=a.id AND ra.repository_id=m.repository_id AND ra.revision=m.mapping_revision
        JOIN threads t ON t.owner_user_id=m.owner_user_id AND t.id=m.thread_id AND t.deleted_at IS NULL
        WHERE m.owner_user_id=${r.owner_user_id}::uuid AND m.request_id=${r.request_id}::uuid AND m.state='accepted'
        FOR UPDATE OF m,t`;

          if (!rows[0]) return;
          yield* sql`INSERT INTO thread_pull_requests(owner_user_id,thread_id,pull_request_id,source,evidence,head_repository_id,head_ref,head_oid)
        VALUES (${r.owner_user_id}::uuid,${r.thread_id}::uuid,${ref.id}::uuid,'auto','product_create',${snapshot.headRepositoryId},${snapshot.headRef},${snapshot.summary?.headSha ?? r.head_sha})
        ON CONFLICT(owner_user_id,thread_id,pull_request_id) DO UPDATE SET last_seen_at=now()
        WHERE thread_pull_requests.unlinked_at IS NULL`;

          const saved =
            (yield* sql<MutationRow>`UPDATE github_mutation_receipts SET state='succeeded',pull_request_id=${ref.id}::uuid,created_pr=${JSON.stringify(toJson(github.PullRequestRefSchema, ref))}::jsonb,detail='',updated_at=now()
        WHERE owner_user_id=${r.owner_user_id}::uuid AND request_id=${r.request_id}::uuid RETURNING *`)[0]!;

          yield* audit(saved, "succeeded");
          yield* sql`UPDATE threads SET pull_request_revision=pull_request_revision+1 WHERE owner_user_id=${r.owner_user_id}::uuid AND id=${r.thread_id}::uuid`;

          return saved;
        }),
      ),
  };
}
