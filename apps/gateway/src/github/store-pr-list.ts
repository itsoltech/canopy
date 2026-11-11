import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { PullRequestRow } from "./store-pull-requests.ts";

export function githubPrList(sql: SqlClient.SqlClient) {
  return {
    prList: (owner: string, id: string) =>
      Effect.gen(function* () {
        const current = (yield* sql<{ pull_request_revision: bigint }>`SELECT pull_request_revision FROM threads
        WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid AND deleted_at IS NULL`)[0];

        if (!current) return yield* Effect.fail(new ConnectError("Thread not found", Code.NotFound));

        const rows = yield* sql<
          PullRequestRow & {
            source: string;
            evidence: string;
            current_branch: boolean;
            created_at: Date;
            payload: JsonValue | null;
          }
        >`SELECT p.*,l.source,l.evidence,l.created_at,c.payload,
        coalesce((c.payload->>'headRef')=coalesce(nullif(g.context->>'pushRef',''),g.context->>'branch')
          AND nullif(g.context->>'branch','') IS NOT NULL
          AND coalesce(g.context->>'ambiguous','false')='false'
          AND ((c.payload->'summary'->>'state') IN ('open','draft') OR (c.payload->'summary'->>'headSha')=g.context->>'headOid')
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(g.context->'remotes') r,
            jsonb_array_elements_text(r->'pushRepositories') n
            WHERE r->>'name'=g.context->>'pushRemote' AND lower(n)=lower('github.com/'||(c.payload->>'headRepositoryName'))),false) AS current_branch
        FROM thread_pull_requests l JOIN github_pull_requests p ON p.owner_user_id=l.owner_user_id AND p.id=l.pull_request_id
        LEFT JOIN LATERAL (SELECT context FROM github_git_contexts WHERE owner_user_id=l.owner_user_id
          AND thread_id=l.thread_id ORDER BY id DESC LIMIT 1) g ON true
        LEFT JOIN github_repository_accounts r ON r.owner_user_id=p.owner_user_id AND r.repository_id=p.repository_id
        LEFT JOIN github_accounts a ON a.owner_user_id=r.owner_user_id AND a.id=r.account_id AND a.status='connected'
        LEFT JOIN github_pr_cache c ON c.owner_user_id=a.owner_user_id AND c.account_id=a.id AND c.access_revision=a.revision
          AND c.cache_key='summary:'||p.repository_id||':'||p.number
        WHERE l.owner_user_id=${owner}::uuid AND l.thread_id=${id}::uuid AND l.unlinked_at IS NULL
        ORDER BY current_branch DESC,p.created_at DESC,p.id`;

        return create(github.ThreadPullRequestsResponseSchema, {
          revision: BigInt(current.pull_request_revision),
          links: rows.map((r) => ({
            summary: r.payload
              ? fromJson(github.PullRequestSnapshotSchema, r.payload).summary
              : {
                  ref: {
                    id: r.id,
                    host: "github.com",
                    repositoryId: r.repository_id,
                    repositoryName: r.repository_name,
                    number: r.number,
                    nodeId: r.node_id,
                  },
                  state: "unavailable",
                },
            source: r.source,
            evidence: r.evidence,
            currentBranch: r.current_branch,
            createdAt: { seconds: BigInt(Math.floor(Number(new Date(r.created_at)) / 1000)) },
          })),
        });
      }),
  };
}
