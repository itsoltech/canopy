import type { JsonValue } from "@bufbuild/protobuf";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { Invalid, NotFound, one, type Fx } from "./errors.ts";

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
  insertWorktree(row: Omit<WorktreeRow, "created_at" | "last_used_at" | "removed_at">): Fx<WorktreeRow>;
  /** A live worktree of the owner's, in the project and workspace. */
  ownWorktree(ownerUserId: string, id: string, projectId: string, workspaceId: string): Fx<WorktreeRow>;
  /** Live worktrees of a project on a worker, the most recently used first. */
  listWorktrees(
    ownerUserId: string,
    projectId: string,
    workerId: string,
    workspaceId: string,
  ): Fx<readonly WorktreeRow[]>;
  /** A generated branch name replaces the first one (only while it is still the stored name). */
  renameWorktree(id: string, from: string, to: string): Fx<string[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function worktreeStore(sql: SqlClient.SqlClient): WorktreeStore {
  return {
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
      }),

    insertWorktree: (row) =>
      sql<WorktreeRow>`
            INSERT INTO worktrees (id, owner_user_id, project_id, workspace_id, worker_id, repo_root, path, branch, base_ref, base_commit)
            VALUES (${row.id}::uuid, ${row.owner_user_id}::uuid, ${row.project_id}::uuid, ${row.workspace_id}::uuid,
                    ${row.worker_id}::uuid, ${row.repo_root}, ${row.path}, ${row.branch}, ${row.base_ref}, ${row.base_commit})
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
             ORDER BY last_used_at DESC LIMIT 20`,

    renameWorktree: (id, from, to) =>
      Effect.gen(function* () {
        yield* sql`UPDATE worktrees SET branch = ${to} WHERE id = ${id}::uuid AND branch = ${from}`;
        const rows = yield* sql<{ id: string }>`SELECT id FROM threads WHERE worktree_id = ${id}::uuid`;

        return rows.map((row) => row.id);
      }),
  };
}
