import type { JsonValue } from "@bufbuild/protobuf";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { Invalid, NotFound, one, type Fx } from "./errors.ts";
import { projectTransaction } from "../config-sync/project-records.ts";

/**
 * Git worktrees (docs/worktrees.md): the owner's settings in four scopes and the worktrees threads work in.
 * Merging the scopes and the settings' shape belong to worktrees/settings.ts; this stores them.
 */

/** The scope's version moved on since the client read it: it reloads and applies its change again. */
export class WorktreeSettingsConflict extends Error {
  override readonly name = "WorktreeSettingsConflict";
}

type FxConflict<A> = Effect.Effect<A, SqlError.SqlError | Invalid | WorktreeSettingsConflict>;

export interface WorktreeScopeRow {
  project_id: string | null;
  worker_id: string | null;
  /** Protobuf JSON of ui.WorktreeSettings: only the fields the scope overrides. */
  settings: JsonValue;
  version: bigint | number;
}

export interface WorktreeRow {
  external: boolean;
  id: string;
  owner_user_id: string;
  project_id: string;
  workspace_id: string;
  worker_id: string;
  repo_root: string;
  path: string;
  branch: string;
  base_ref: string;
  base_commit: string;
  created_at: Date;
  last_used_at: Date;
  removed_at: Date | null;
  location: string;
  /** Detached HEAD: the short commit the worker reported (`branch` keeps the last branch); empty = on `branch`. */
  detached_commit: string;
  /** provisional | generated | kept | fixed (migration 0087, docs/worktrees.md "Nazwy gałęzi"). */
  branch_source: string;
  /** Generations claimed for a provisional name. */
  branch_attempts: number;
  /** The name the worktree was created with when it was provisional. */
  provisional_branch: string;
}

export interface WorktreeStore {
  /** The rows of every scope that applies to a project on a worker (NULL = all), broadest first. */
  worktreeScopes(
    ownerUserId: string,
    projectId: string | null,
    workerId: string | null,
  ): Fx<readonly WorktreeScopeRow[]>;
  /** Replaces a scope's overrides; `expectedVersion` 0 = the scope does not exist yet. Returns the new version. */
  saveWorktreeScope(input: {
    ownerUserId: string;
    projectId: string | null;
    workerId: string | null;
    settings: JsonValue;
    expectedVersion: bigint;
  }): FxConflict<bigint>;
  insertWorktree(
    row: Omit<
      WorktreeRow,
      | "created_at"
      | "last_used_at"
      | "removed_at"
      | "location"
      | "detached_commit"
      | "branch_source"
      | "branch_attempts"
      | "provisional_branch"
      | "external"
    > & { location?: string; provisional?: boolean; external?: boolean; detachedCommit?: string },
  ): Fx<WorktreeRow>;
  /** A live worktree of the owner's, in the project and workspace. */
  ownWorktree(ownerUserId: string, id: string, projectId: string, workspaceId: string): Fx<WorktreeRow>;
  /** Live worktrees of a project on a worker, the most recently used first. */
  listWorktrees(
    ownerUserId: string,
    projectId: string,
    workerId: string,
    workspaceId: string,
  ): Fx<readonly WorktreeRow[]>;
  /** A generated branch name replaces the provisional one (unless another name was reported meanwhile). */
  renameWorktree(id: string, from: string, to: string): Fx<string[]>;
  /**
   * One generation for a provisional branch name, at most `max` in all. A worktree whose HEAD is no longer on the
   * provisional name (switched, renamed, detached) is kept instead. Undefined: nothing to name.
   */
  claimBranchName(id: string, max: number): Fx<WorktreeRow | undefined>;
  /** A provisional name stays for good (the worker refused: pushed, switched, renamed by hand). */
  keepBranch(id: string): Fx<void>;
  /** The user's requests (first and latest) and the agent's latest answer, bounded, for a branch name. */
  branchContext(threadId: string): Fx<{ readonly requests: string[]; readonly answer: string }>;
  /**
   * The live HEAD of one checkout of the worker's threads (GitHeads): their worktree's branch, or the workspace's
   * own checkout. Returns the threads that show a changed branch.
   */
  saveGitHead(workerId: string, threadIds: readonly string[], head: GitHeadValue): Fx<string[]>;
}

export interface GitHeadValue {
  readonly branch: string;
  readonly detachedCommit: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function worktreeStore(sql: SqlClient.SqlClient): WorktreeStore {
  return {
    ...branchStore(sql),
    worktreeScopes: (ownerUserId, projectId, workerId) =>
      sql<WorktreeScopeRow>`
            SELECT project_id, worker_id, settings, version FROM worktree_settings
             WHERE owner_user_id = ${ownerUserId}::uuid
               AND (project_id IS NULL OR project_id = ${projectId}::uuid)
               AND (worker_id IS NULL OR worker_id = ${workerId}::uuid)
             ORDER BY (project_id IS NOT NULL), (worker_id IS NOT NULL)`,

    saveWorktreeScope: ({ ownerUserId, projectId, workerId, settings, expectedVersion }) =>
      Effect.gen(function* () {
        if ([projectId, workerId].some((id) => id !== null && !UUID.test(id)))
          return yield* Effect.fail(new Invalid("unknown scope"));
        const json = JSON.stringify(settings);

        const rows =
          expectedVersion === 0n
            ? yield* sql<{ version: bigint }>`
                  INSERT INTO worktree_settings (owner_user_id, project_id, worker_id, settings)
                  VALUES (${ownerUserId}::uuid, ${projectId}::uuid, ${workerId}::uuid, ${json}::jsonb)
                  ON CONFLICT DO NOTHING RETURNING version`
            : yield* sql<{ version: bigint }>`
                  UPDATE worktree_settings SET settings = ${json}::jsonb, version = version + 1, updated_at = now()
                   WHERE owner_user_id = ${ownerUserId}::uuid AND version = ${expectedVersion}
                     AND project_id IS NOT DISTINCT FROM ${projectId}::uuid
                     AND worker_id IS NOT DISTINCT FROM ${workerId}::uuid
                  RETURNING version`;

        if (!rows[0]) return yield* Effect.fail(new WorktreeSettingsConflict("worktree settings changed elsewhere"));

        return BigInt(rows[0].version);
      }).pipe((fx) => projectTransaction(sql, fx)),

    insertWorktree: (row) =>
      sql<WorktreeRow>`
            INSERT INTO worktrees (id, owner_user_id, project_id, workspace_id, worker_id, repo_root, path, branch, base_ref,
                                   base_commit, location, branch_source, provisional_branch, external, detached_commit)
            VALUES (${row.id}::uuid, ${row.owner_user_id}::uuid, ${row.project_id}::uuid, ${row.workspace_id}::uuid,
                    ${row.worker_id}::uuid, ${row.repo_root}, ${row.path}, ${row.branch}, ${row.base_ref}, ${row.base_commit},
                    ${row.location ?? ""}, ${row.provisional && !row.external ? "provisional" : "fixed"}, ${row.provisional ? row.branch : ""},
                    ${row.external ?? false}, ${row.detachedCommit ?? ""})
            ON CONFLICT (worker_id, path) WHERE removed_at IS NULL DO UPDATE SET last_used_at = now()
              WHERE worktrees.owner_user_id = EXCLUDED.owner_user_id
                AND worktrees.project_id = EXCLUDED.project_id AND worktrees.workspace_id = EXCLUDED.workspace_id
            RETURNING *`.pipe(Effect.flatMap((rows) => one(rows, "worktree"))),

    ownWorktree: (ownerUserId, id, projectId, workspaceId) =>
      Effect.gen(function* () {
        if (!UUID.test(id)) return yield* Effect.fail(new NotFound("worktree not found"));

        return yield* one(
          yield* sql<WorktreeRow>`
                UPDATE worktrees SET last_used_at = now()
                 WHERE id = ${id}::uuid AND owner_user_id = ${ownerUserId}::uuid AND project_id = ${projectId}::uuid
                   AND workspace_id = ${workspaceId}::uuid AND removed_at IS NULL
                RETURNING *`,
          "worktree",
        );
      }),

    listWorktrees: (ownerUserId, projectId, workerId, workspaceId) =>
      sql<WorktreeRow>`
            SELECT * FROM worktrees
             WHERE owner_user_id = ${ownerUserId}::uuid AND project_id = ${projectId}::uuid
               AND worker_id = ${workerId}::uuid AND removed_at IS NULL
               AND workspace_id = ${workspaceId}::uuid
             ORDER BY last_used_at DESC`,

    renameWorktree: (id, from, to) =>
      Effect.gen(function* () {
        // The worker's GitHeads may report the new name before the command result arrives.
        yield* sql`UPDATE worktrees SET branch = ${to}, branch_source = 'generated'
                    WHERE id = ${id}::uuid AND branch IN (${from}, ${to}) AND branch_source = 'provisional'`;
        const rows = yield* sql<{ id: string }>`SELECT id FROM threads WHERE worktree_id = ${id}::uuid`;

        return rows.map((row) => row.id);
      }),
  };
}

/** Live heads and generated names of worktree branches (docs/worktrees.md). */
function branchStore(
  sql: SqlClient.SqlClient,
): Pick<WorktreeStore, "claimBranchName" | "keepBranch" | "branchContext" | "saveGitHead"> {
  return {
    claimBranchName: (id, max) =>
      Effect.gen(function* () {
        if (!UUID.test(id)) return undefined;
        yield* sql`UPDATE worktrees SET branch_source = 'kept'
                    WHERE id = ${id}::uuid AND branch_source = 'provisional'
                      AND (branch <> provisional_branch OR detached_commit <> '')`;

        const rows = yield* sql<WorktreeRow>`
              UPDATE worktrees SET branch_attempts = branch_attempts + 1
               WHERE id = ${id}::uuid AND NOT external AND branch_source = 'provisional' AND removed_at IS NULL AND branch_attempts < ${max}
              RETURNING *`;

        return rows[0];
      }),

    keepBranch: (id) =>
      sql`UPDATE worktrees SET branch_source = 'kept' WHERE id = ${id}::uuid AND branch_source = 'provisional'`.pipe(
        Effect.asVoid,
      ),

    branchContext: (threadId) =>
      Effect.gen(function* () {
        const requests = yield* sql<{ text: string }>`
              SELECT left(COALESCE(u.input->>'message', u.input->>'text', ''), 600) AS text FROM turns u
               WHERE u.thread_id = ${threadId}::uuid AND u.trigger IN ('user', 'goal', 'agent_bus')
                 AND COALESCE(u.input->>'message', u.input->>'text', '') <> ''
               ORDER BY u.ordinal`;

        const answer = yield* sql<{ text: string | null }>`
              SELECT left(m.content->'agentMessage'->>'text', 800) AS text FROM thread_items m
               WHERE m.thread_id = ${threadId}::uuid AND m.type = 'agent_message' ORDER BY m.first_seq DESC LIMIT 1`;

        const texts = requests.map((r) => r.text);

        return { requests: [...texts.slice(0, 1), ...texts.slice(1).slice(-3)], answer: answer[0]?.text ?? "" };
      }),

    saveGitHead: (workerId, threadIds, { branch, detachedCommit }) =>
      Effect.gen(function* () {
        const ids = threadIds.filter((id) => UUID.test(id));

        if (ids.length === 0) return [];

        // A thread in a subfolder may be in another repository: only threads at the workspace root report its checkout.
        const rows = yield* sql<{ id: string }>`
              WITH reported AS (
                SELECT t.worktree_id, t.workspace_id, (t.cwd IS NULL OR t.cwd = ws.root_path) AS at_root
                  FROM threads t JOIN project_workspaces ws ON ws.id = t.workspace_id
                 WHERE t.id = ANY(${ids}::uuid[]) AND t.worker_id = ${workerId}::uuid AND ws.worker_id = t.worker_id
              ), worktree AS (
                UPDATE worktrees w SET branch = coalesce(nullif(${branch}, ''), w.branch), detached_commit = ${detachedCommit}
                 WHERE w.id IN (SELECT worktree_id FROM reported) AND w.worker_id = ${workerId}::uuid
                   AND w.removed_at IS NULL
                   AND (w.branch, w.detached_commit) IS DISTINCT FROM (coalesce(nullif(${branch}, ''), w.branch), ${detachedCommit})
                RETURNING w.id
              ), checkout AS (
                INSERT INTO checkout_heads (workspace_id, branch, detached_commit)
                SELECT DISTINCT workspace_id, ${branch}, ${detachedCommit} FROM reported WHERE worktree_id IS NULL AND at_root
                ON CONFLICT (workspace_id) DO UPDATE SET branch = EXCLUDED.branch,
                       detached_commit = EXCLUDED.detached_commit, updated_at = now()
                 WHERE (checkout_heads.branch, checkout_heads.detached_commit)
                       IS DISTINCT FROM (EXCLUDED.branch, EXCLUDED.detached_commit)
                RETURNING workspace_id
              )
              SELECT t.id FROM threads t
               WHERE t.worktree_id IN (SELECT id FROM worktree)
                  OR (t.worktree_id IS NULL AND t.workspace_id IN (SELECT workspace_id FROM checkout))`;

        return rows.map((row) => row.id);
      }),
  };
}
