import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { github } from "@canopy/contracts";
import { reviewParameters } from "./review-mutation.ts";

export interface MutationRow {
  owner_user_id: string;
  request_id: string;
  account_id: string;
  pull_request_id: string;
  client_binding: string;
  fingerprint: string;
  action: string;
  access_revision: bigint;
  mapping_revision: bigint;
  head_sha: string;
  expected_state: string;
  resource_id: string;
  path: string;
  state: string;
  confirmation_id: string;
  expires_at: Date;
  upstream_id: string;
  detail: string;
  viewer_viewed_state: string;
  parameters: ReturnType<typeof reviewParameters>;
}

export const uncertainDetail = "Couldn't confirm. Check on GitHub";
const missing = () => new ConnectError("Mutation not found", Code.NotFound);

export function githubMutationsStore(sql: SqlClient.SqlClient) {
  const audit = (r: MutationRow, outcome: string) =>
    sql`INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
      VALUES (${Bun.randomUUIDv7()}::uuid,${r.owner_user_id}::uuid,${`github.${r.action}`},'github_pull_request',${r.pull_request_id}::uuid,
      ${JSON.stringify({
        requestId: r.request_id,
        client: r.client_binding,
        accountId: r.account_id,
        resourceId: r.resource_id,
        path: r.path,
        headSha: r.head_sha,
        accessRevision: String(r.access_revision),
        confirmationId: r.confirmation_id,
        outcome,
        upstreamId: r.upstream_id,
        parameters: r.parameters,
      })}::jsonb)`;

  const get = (owner: string, id: string) =>
    sql<MutationRow>`SELECT * FROM github_mutation_receipts WHERE owner_user_id=${owner}::uuid AND request_id=${id}::uuid`;

  return {
    mutationGet: (owner: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const recovered =
            yield* sql<MutationRow>`UPDATE github_mutation_receipts SET state='uncertain',detail=${uncertainDetail},updated_at=now()
        WHERE owner_user_id=${owner}::uuid AND request_id=${id}::uuid AND state='in_flight' AND lease_until<now() RETURNING *`;

          if (recovered[0]) yield* audit(recovered[0], "uncertain");

          return yield* get(owner, id);
        }),
      ),
    mutationPrepare: (
      owner: string,
      client: string,
      r: github.PullRequestMutationRequest,
      fingerprint: string,
      mapping: bigint,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<MutationRow>`INSERT INTO github_mutation_receipts
          (owner_user_id,request_id,account_id,pull_request_id,client_binding,fingerprint,action,access_revision,mapping_revision,
          head_sha,expected_state,resource_id,path,confirmation_id,parameters)
          VALUES (${owner}::uuid,${r.clientRequestId}::uuid,${r.accountId}::uuid,${r.pullRequestId}::uuid,${client},${fingerprint},
          ${r.action},${r.accessRevision}::bigint,${mapping}::bigint,${r.headSha},${r.expectedState},${r.resourceId},${r.path},${Bun.randomUUIDv7()}::uuid,${JSON.stringify(reviewParameters(r))}::jsonb)
          ON CONFLICT DO NOTHING RETURNING *`;

          if (rows[0]) yield* audit(rows[0], "prepared");

          return rows.length ? rows : yield* get(owner, r.clientRequestId);
        }),
      ),
    mutationClaim: (r: MutationRow, confirmation: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql<MutationRow>`UPDATE github_mutation_receipts m SET state='in_flight',lease_until=now()+interval '60 seconds',updated_at=now()
        WHERE m.owner_user_id=${r.owner_user_id}::uuid AND m.request_id=${r.request_id}::uuid AND m.state='prepared'
        AND m.expires_at>now() AND (m.action NOT IN ('delete_comment','discard_review') OR m.confirmation_id::text=${confirmation})
        AND EXISTS(SELECT 1 FROM github_accounts a JOIN github_repository_accounts ra ON ra.owner_user_id=a.owner_user_id AND ra.account_id=a.id
          JOIN github_pull_requests p ON p.owner_user_id=ra.owner_user_id AND p.repository_id=ra.repository_id
          WHERE a.owner_user_id=m.owner_user_id AND a.id=m.account_id AND a.revision=m.access_revision AND a.status='connected'
          AND ra.revision=m.mapping_revision AND p.id=m.pull_request_id) RETURNING m.*`;

          if (rows[0]) yield* audit(rows[0], "in_flight");

          return rows[0];
        }),
      ),
    mutationFinish: (r: MutationRow, state: string, upstream = "", detail = "", viewed = "") =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql<MutationRow>`UPDATE github_mutation_receipts SET state=${state},upstream_id=${upstream},detail=${detail},
          viewer_viewed_state=${viewed},lease_until=NULL,updated_at=now() WHERE owner_user_id=${r.owner_user_id}::uuid
          AND request_id=${r.request_id}::uuid AND state='in_flight' RETURNING *`;

          if (!rows[0]) return yield* Effect.fail(missing());
          yield* audit(rows[0], state);
          // Invalidate only this PR's mutable pages. Immutable patches keep their cache.
          yield* sql`UPDATE github_pr_cache SET expires_at=now(),etag='',generation=generation+1
          WHERE owner_user_id=${r.owner_user_id}::uuid AND account_id=${r.account_id}::uuid
          AND (cache_key LIKE ${`viewed:${r.pull_request_id}:%`} OR cache_key=${`pending-header:${r.pull_request_id}`}
          OR cache_key LIKE (SELECT 'pending:'||repository_id||':'||number||':%' FROM github_pull_requests WHERE owner_user_id=${r.owner_user_id}::uuid AND id=${r.pull_request_id}::uuid)
          OR cache_key LIKE (SELECT 'timeline:'||repository_id||':'||number||':%' FROM github_pull_requests WHERE owner_user_id=${r.owner_user_id}::uuid AND id=${r.pull_request_id}::uuid)
          OR cache_key LIKE (SELECT 'reviews:'||repository_id||':'||number||':%' FROM github_pull_requests WHERE owner_user_id=${r.owner_user_id}::uuid AND id=${r.pull_request_id}::uuid))`;

          return rows[0];
        }),
      ),
    mutationPermission: (owner: string, account: string, repo: string) => sql<{ permissions: Record<string, string> }>`
      SELECT i.permissions FROM github_installation_repositories r JOIN github_installations i USING(owner_user_id,account_id,installation_id)
      WHERE r.owner_user_id=${owner}::uuid AND r.account_id=${account}::uuid AND r.repository_id=${repo} AND NOT i.suspended`,
    mutationPace: (user: string) => sql`UPDATE github_api_budgets SET last_mutation_at=now()
      WHERE github_user_id=${user} AND resource='graphql' AND (last_mutation_at IS NULL OR last_mutation_at<now()-interval '1 second') RETURNING github_user_id`,
    mutationDenied: (owner: string, client: string, pr: string, request: string, action: string) =>
      sql`INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
        VALUES (${Bun.randomUUIDv7()}::uuid,${owner}::uuid,'github.mutation_denied','github_pull_request',${pr}::uuid,
        ${JSON.stringify({ client, requestId: request, action, outcome: "denied" })}::jsonb)`,
  };
}
