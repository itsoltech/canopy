import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { AccountRow } from "./records.ts";
import { githubPrList } from "./store-pr-list.ts";

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
}

export interface DetectionEvidence {
  repository: string;
  ref: string;
  sha: string;
  context: bigint;
  lease: string;
  kind: "branch" | "tool_output";
}

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

  const project = (owner: string, id: string) => sql`WITH projection AS (
    SELECT (SELECT count(*) FROM thread_pull_requests l WHERE l.owner_user_id=${owner}::uuid AND l.thread_id=${id}::uuid AND l.unlinked_at IS NULL) AS count,
    (SELECT c.payload->'summary' FROM thread_pull_requests l
      JOIN github_pull_requests p ON p.owner_user_id=l.owner_user_id AND p.id=l.pull_request_id
      LEFT JOIN github_repository_accounts r ON r.owner_user_id=p.owner_user_id AND r.repository_id=p.repository_id
      LEFT JOIN github_accounts a ON a.owner_user_id=r.owner_user_id AND a.id=r.account_id AND a.status='connected'
      LEFT JOIN github_pr_cache c ON c.owner_user_id=a.owner_user_id AND c.account_id=a.id AND c.access_revision=a.revision
        AND c.cache_key='summary:'||p.repository_id||':'||p.number
      WHERE l.owner_user_id=${owner}::uuid AND l.thread_id=${id}::uuid AND l.unlinked_at IS NULL ORDER BY p.created_at DESC,p.id LIMIT 1) AS summary
    ) UPDATE threads t SET pull_request_count=p.count,newest_pull_request=p.summary,pull_request_revision=pull_request_revision+1
      FROM projection p WHERE t.owner_user_id=${owner}::uuid AND t.id=${id}::uuid
      AND (t.pull_request_count,t.newest_pull_request) IS DISTINCT FROM (p.count,p.summary)`;

  return { thread, project };
}

export function githubPullRequests(sql: SqlClient.SqlClient) {
  const { thread, project } = projectionStore(sql);

  return {
    prThread: thread,
    prProject: project,
    repositoryAccount: (
      owner: string,
      name: string,
    ) => sql<RepositoryAccountRow>`SELECT * FROM github_repository_accounts
      WHERE owner_user_id=${owner}::uuid AND lower(repository_name)=lower(${name})`,
    repositoryCandidates: (owner: string, name: string) => sql<AccountRow>`SELECT DISTINCT a.* FROM github_accounts a
      LEFT JOIN github_installation_repositories r ON r.owner_user_id=a.owner_user_id AND r.account_id=a.id
      LEFT JOIN github_installations i ON i.owner_user_id=r.owner_user_id AND i.account_id=r.account_id AND i.installation_id=r.installation_id
      WHERE a.owner_user_id=${owner}::uuid AND a.status='connected' AND (a.auth_kind='pat' OR (lower(r.full_name)=lower(${name}) AND NOT i.suspended))`,
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
      evidence?: DetectionEvidence,
    ) => linkPullRequest(sql, owner, id, pr, expected, source, snapshot, evidence),
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
  evidence?: DetectionEvidence,
) {
  const { thread, project } = projectionStore(sql);

  return sql.withTransaction(
    Effect.gen(function* () {
      const current = yield* thread(owner, id, true);

      if (BigInt(current.pull_request_revision) !== expected) return yield* Effect.fail(conflict());

      if (evidence) {
        const valid = yield* sql`SELECT 1 FROM github_detection_jobs WHERE owner_user_id=${owner}::uuid
          AND thread_id=${id}::uuid AND lease_id=${evidence.lease}::uuid AND lease_until>now()`;

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
      VALUES (${owner}::uuid,${id}::uuid,${pr}::uuid,${source},${evidence?.kind ?? (source === "manual" ? "manual" : "branch")},${evidence?.repository ?? ""},${evidence?.ref ?? ""},${evidence?.sha ?? ""},${evidence?.context ?? null}::bigint)
      ON CONFLICT(owner_user_id,thread_id,pull_request_id) DO UPDATE SET unlinked_at=NULL,last_seen_at=now(),
        source=CASE WHEN thread_pull_requests.source='manual' THEN 'manual' ELSE excluded.source END
      WHERE ${source === "manual"} OR thread_pull_requests.unlinked_at IS NULL RETURNING pull_request_id`;

      if (linked.length) yield* project(owner, id);
    }),
  );
}
