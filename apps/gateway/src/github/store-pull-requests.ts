import { lockedOwnerModule, moduleDisabledMessage } from "../store/module-access.ts";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import type { SqlClient, Statement } from "effect/sql";
import type { AccountRow } from "./records.ts";
import { githubPrList } from "./store-pr-list.ts";
import { githubPrSummaries } from "./store-pr-summary.ts";

export interface RepositoryAccountRow {
  repository_id: string;
  repository_name: string;
  account_id: string;
  revision: bigint;
}

export interface PullRequestRow {
  id: string;
  repository_id: string;
  repository_name: string;
  number: number;
  node_id: string;
  refresh_detail: string;
  refreshed_at: Date | null;
}

export interface DetectionEvidence {
  repository: string;
  ref: string;
  sha: string;
  context: bigint;
  lease: string;
  kind: "branch" | "tool_output";
}

export interface AgentLinkEvidence {
  kind: "agent_tool";
}

export type PullRequestLinkEvidence = DetectionEvidence | AgentLinkEvidence;

const conflict = () => new ConnectError("Pull requests changed. Refresh, then retry.", Code.Aborted);
const missing = () => new ConnectError("Pull request or thread not found", Code.NotFound);

function projectionStore(sql: SqlClient.SqlClient) {
  const thread = (owner: string, id: string, lock = false) =>
    Effect.gen(function* () {
      const rows = yield* sql.unsafe<{ pull_request_revision: bigint }>(
        `SELECT pull_request_revision FROM threads WHERE owner_user_id=$1::uuid AND id=$2::uuid AND deleted_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
        [owner, id],
      );

      if (!rows[0]) return yield* Effect.fail(missing());

      return rows[0];
    });

  const projection = (owner: string, id: string | Statement.Fragment) => sql`
    SELECT (SELECT count(*) FROM thread_pull_requests l WHERE l.owner_user_id=${owner}::uuid AND l.thread_id=${id}::uuid AND l.unlinked_at IS NULL) AS count,
    (SELECT s.summary FROM thread_pull_requests l JOIN github_pr_projection_summaries s ON s.owner_user_id=l.owner_user_id AND s.id=l.pull_request_id
      WHERE l.owner_user_id=${owner}::uuid AND l.thread_id=${id}::uuid AND l.unlinked_at IS NULL
      ORDER BY s.created_at DESC,s.id LIMIT 1) AS summary`;

  const differs = sql`(t.pull_request_count,t.newest_pull_request) IS DISTINCT FROM (p.count,p.summary)`;

  const project = (owner: string, id: string, pr?: string) => {
    // A link's fingerprint and the thread revision commit together under the thread row lock.
    const filter = pr ? sql`AND l.pull_request_id=${pr}::uuid` : sql``;

    return sql<{ id: string }>`WITH projection AS (${projection(owner, id)}), marked AS (
      UPDATE thread_pull_requests l SET projected_summary_hash=s.summary_hash FROM github_pr_projection_summaries s
      WHERE l.owner_user_id=${owner}::uuid AND l.thread_id=${id}::uuid ${filter}
        AND l.unlinked_at IS NULL AND s.owner_user_id=l.owner_user_id AND s.id=l.pull_request_id
        AND l.projected_summary_hash IS DISTINCT FROM s.summary_hash RETURNING l.pull_request_id
    ) UPDATE threads t SET pull_request_count=p.count,newest_pull_request=p.summary,pull_request_revision=pull_request_revision+1
      FROM projection p WHERE t.owner_user_id=${owner}::uuid AND t.id=${id}::uuid AND (${differs}
        OR EXISTS (SELECT 1 FROM marked WHERE p.summary->'ref'->>'id' IS DISTINCT FROM pull_request_id::text)) RETURNING t.id`;
  };

  const linked = (owner: string, pr: string) => sql<{ id: string }>`
    SELECT t.id FROM thread_pull_requests l JOIN threads t ON t.owner_user_id=l.owner_user_id AND t.id=l.thread_id
      JOIN github_pr_projection_summaries s ON s.owner_user_id=l.owner_user_id AND s.id=l.pull_request_id
    WHERE l.owner_user_id=${owner}::uuid AND l.pull_request_id=${pr}::uuid AND l.unlinked_at IS NULL
      AND (l.projected_summary_hash IS DISTINCT FROM s.summary_hash OR EXISTS (SELECT 1 FROM (${projection(owner, sql`t.id`)}) p WHERE ${differs}))`;

  return { thread, project, linked };
}

export function githubPullRequests(sql: SqlClient.SqlClient) {
  const { thread, project, linked } = projectionStore(sql);

  return {
    prThread: thread,
    prLinkedThreads: linked,
    prNewestSummaryChanged: (owner: string, id: string) => sql<{ id: string }>`
      SELECT t.id FROM threads t JOIN github_pr_projection_summaries s
        ON s.owner_user_id=t.owner_user_id AND s.id=(t.newest_pull_request->'ref'->>'id')::uuid
      WHERE t.owner_user_id=${owner}::uuid AND t.id=${id}::uuid AND t.deleted_at IS NULL
        AND t.newest_pull_request IS DISTINCT FROM s.summary`,
    prProject: (owner: string, id: string, pr?: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT id FROM threads WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid FOR NO KEY UPDATE`;

          return yield* project(owner, id, pr);
        }),
      ),
    repositoryAccount: (
      owner: string,
      name: string,
    ) => sql<RepositoryAccountRow>`SELECT * FROM github_repository_accounts
      WHERE owner_user_id=${owner}::uuid AND lower(repository_name)=lower(${name})`,
    repositoryInstalled: (
      owner: string,
      account: string,
      repo: string,
    ) => sql`SELECT r.repository_id FROM github_installation_repositories r
      JOIN github_installations i USING(owner_user_id,account_id,installation_id) WHERE r.owner_user_id=${owner}::uuid
      AND r.account_id=${account}::uuid AND r.repository_id=${repo} AND NOT i.suspended`,
    repositoryChoose: (row: AccountRow, repo: string, name: string, expected: bigint) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const active = yield* sql`SELECT id FROM github_accounts WHERE owner_user_id=${row.owner_user_id}::uuid
        AND id=${row.id}::uuid AND revision=${row.revision}::bigint AND status='connected' FOR UPDATE`;

          if (!active.length) return yield* Effect.fail(missing());

          const result =
            yield* sql<RepositoryAccountRow>`INSERT INTO github_repository_accounts(owner_user_id,repository_id,repository_name,account_id)
        SELECT ${row.owner_user_id}::uuid,${repo},${name},${row.id}::uuid WHERE ${expected}::bigint=0
          OR EXISTS(SELECT 1 FROM github_repository_accounts WHERE owner_user_id=${row.owner_user_id}::uuid AND repository_id=${repo})
        ON CONFLICT(owner_user_id,repository_id) DO UPDATE SET account_id=excluded.account_id,repository_name=excluded.repository_name,revision=github_repository_accounts.revision+1
        WHERE github_repository_accounts.revision=${expected}::bigint RETURNING *`;

          if (!result[0]) return yield* Effect.fail(conflict());
          yield* sql`DELETE FROM github_pr_cache WHERE owner_user_id=${row.owner_user_id}::uuid
        AND account_id<>${row.id}::uuid AND cache_key LIKE ${`%:${repo}:%`}`;
          yield* sql`UPDATE github_pull_requests SET summary=NULL,summary_account_id=NULL
        WHERE owner_user_id=${row.owner_user_id}::uuid AND repository_id=${repo} AND summary_account_id<>${row.id}::uuid`;
          // The account can change while two accounts expose identical small summaries.
          yield* sql`UPDATE threads SET pull_request_revision=pull_request_revision+1
            WHERE owner_user_id=${row.owner_user_id}::uuid AND id IN (
              SELECT l.thread_id FROM thread_pull_requests l JOIN github_pull_requests p
              ON p.owner_user_id=l.owner_user_id AND p.id=l.pull_request_id
              WHERE l.owner_user_id=${row.owner_user_id}::uuid AND p.repository_id=${repo} AND l.unlinked_at IS NULL)`;

          return result[0];
        }),
      ),
    prOwned: (owner: string, id: string) =>
      Effect.gen(function* () {
        const row =
          (yield* sql<PullRequestRow>`SELECT * FROM github_pull_requests WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid`)[0];

        if (!row) return yield* Effect.fail(missing());

        return row;
      }),
    prSave: (
      owner: string,
      ref: github.PullRequestRef,
      createdAt: Date,
    ) => sql<PullRequestRow>`INSERT INTO github_pull_requests(id,owner_user_id,repository_id,repository_name,number,node_id,created_at)
      VALUES (${Bun.randomUUIDv7()}::uuid,${owner}::uuid,${ref.repositoryId},${ref.repositoryName},${ref.number},${ref.nodeId},${createdAt})
      ON CONFLICT(owner_user_id,host,repository_id,number) DO UPDATE SET repository_name=excluded.repository_name,node_id=excluded.node_id RETURNING *`,
    prLink: (
      owner: string,
      id: string,
      pr: string,
      expected: bigint,
      source: "manual" | "auto" = "manual",
      snapshot?: github.PullRequestSnapshot,
      evidence?: PullRequestLinkEvidence,
    ) => linkPullRequest(sql, owner, id, pr, expected, source, snapshot, evidence),
    prLinkState: (owner: string, id: string, pr: string) => sql<{ unlinked_at: Date | null }>`
      SELECT unlinked_at FROM thread_pull_requests
      WHERE owner_user_id=${owner}::uuid AND thread_id=${id}::uuid AND pull_request_id=${pr}::uuid`,
    prUnlink: (owner: string, id: string, pr: string, expected: bigint) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* thread(owner, id, true);

          if (BigInt(current.pull_request_revision) !== expected) return yield* Effect.fail(conflict());

          const row = yield* sql`UPDATE thread_pull_requests SET unlinked_at=now() WHERE owner_user_id=${owner}::uuid
        AND thread_id=${id}::uuid AND pull_request_id=${pr}::uuid RETURNING pull_request_id`;

          if (!row.length) return yield* Effect.fail(missing());
          yield* project(owner, id);
        }),
      ),
    prThreads: (owner: string, repo?: string) => sql<{
      id: string;
    }>`SELECT DISTINCT l.thread_id AS id FROM thread_pull_requests l
      JOIN github_pull_requests p ON p.owner_user_id=l.owner_user_id AND p.id=l.pull_request_id WHERE l.owner_user_id=${owner}::uuid
      AND l.unlinked_at IS NULL AND (${repo ?? null}::text IS NULL OR p.repository_id=${repo ?? null})`,
    ...githubPrList(sql),
    ...githubPrSummaries(sql),
  };
}

function linkPullRequest(
  sql: SqlClient.SqlClient,
  owner: string,
  id: string,
  pr: string,
  expected: bigint,
  source: "manual" | "auto",
  snapshot?: github.PullRequestSnapshot,
  evidence?: PullRequestLinkEvidence,
) {
  const { thread, project } = projectionStore(sql);

  return sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* lockedOwnerModule(sql, owner, "threads")))
        return yield* Effect.fail(new ConnectError(moduleDisabledMessage("threads"), Code.FailedPrecondition));
      const current = yield* thread(owner, id, true);

      if (BigInt(current.pull_request_revision) !== expected) return yield* Effect.fail(conflict());

      const detection = evidence?.kind === "agent_tool" ? undefined : evidence;

      if (detection) {
        const valid = yield* sql`SELECT 1 FROM github_detection_jobs WHERE owner_user_id=${owner}::uuid
          AND thread_id=${id}::uuid AND lease_id=${detection.lease}::uuid AND lease_until>now()`;

        if (!valid.length) return yield* Effect.fail(conflict());
      }

      if (snapshot) {
        const access = yield* sql`SELECT a.id FROM github_accounts a JOIN github_repository_accounts r
        ON r.owner_user_id=a.owner_user_id AND r.account_id=a.id WHERE a.owner_user_id=${owner}::uuid
        AND a.id=${snapshot.accountId}::uuid AND a.revision=${snapshot.accessRevision}::bigint AND a.status='connected'
        AND r.repository_id=${snapshot.summary?.ref?.repositoryId ?? ""} FOR SHARE OF a,r`;

        if (!access.length) return yield* Effect.fail(conflict());
      }

      const linked =
        yield* sql`INSERT INTO thread_pull_requests(owner_user_id,thread_id,pull_request_id,source,evidence,head_repository_id,head_ref,head_oid,context_id)
      VALUES (${owner}::uuid,${id}::uuid,${pr}::uuid,${source},${evidence?.kind ?? (source === "manual" ? "manual" : "branch")},${detection?.repository ?? ""},${detection?.ref ?? ""},${detection?.sha ?? ""},${detection?.context ?? null}::bigint)
      ON CONFLICT(owner_user_id,thread_id,pull_request_id) DO UPDATE SET unlinked_at=NULL,last_seen_at=now(),
        source=CASE WHEN thread_pull_requests.source='manual' THEN 'manual' ELSE excluded.source END
      WHERE ${source === "manual" && evidence?.kind !== "agent_tool"} OR thread_pull_requests.unlinked_at IS NULL RETURNING pull_request_id`;

      if (linked.length) yield* project(owner, id, pr);

      return linked.length > 0;
    }),
  );
}
