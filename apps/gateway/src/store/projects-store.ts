import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound, one, type Fx } from "./errors.ts";
import { isAbsolutePath, normalizePath, pathKey, pathStyle, scratchBase } from "./paths.ts";

export interface ProjectStore {
  /** `id`: a project shared by a linked computer keeps its id here (docs/linked-computers.md, stage 4). */
  createProject(ownerUserId: string, name: string, id?: string): Fx<ui.Project>;
  lockProject(ownerUserId: string, projectId: string): Fx<void>;
  renameProject(ownerUserId: string, projectId: string, name: string): Fx<void>;
  archiveProject(ownerUserId: string, projectId: string): Fx<void>;
  createWorkspace(input: { projectId: string; workerId: string; rootPath: string; label: string }): Fx<ui.Workspace>;
  /** Another directory (same worker) or label; unset = unchanged. Threads keep their own directory. */
  updateWorkspace(
    ownerUserId: string,
    input: { workspaceId: string; rootPath?: string | undefined; label?: string | undefined },
  ): Fx<ui.Workspace>;
  /** Takes the project off the workspace's worker (archived): no new threads there, existing ones go on. */
  removeWorkspace(ownerUserId: string, workspaceId: string): Fx<ui.Workspace>;
  listProjects(ownerUserId: string): Fx<ui.Project[]>;
}

/**
 * A workspace directory on a worker, normalized: absolute and not
 * already a workspace of the project there (`except`: the workspace being moved).
 */
const workspaceRoot = (
  sql: SqlClient.SqlClient,
  input: { projectId: string; workerId: string; rootPath: string; except?: string },
) =>
  Effect.gen(function* () {
    const { projectId, workerId, rootPath } = input;

    // A project spans workers (Linux, macOS, Windows): the path follows the worker's rules.
    const workers = yield* sql<{ os: string }>`
            SELECT w.os FROM workers w
             WHERE w.id = ${workerId}::uuid AND w.archived_at IS NULL AND w.revoked_at IS NULL`;

    const worker = workers[0];

    if (!worker) return yield* Effect.fail(new NotFound("worker not found"));
    const style = pathStyle(worker.os, rootPath);

    if (!isAbsolutePath(rootPath, style)) return yield* Effect.fail(new Invalid("root path must be absolute"));
    const root = normalizePath(rootPath, style);

    // The core asks the worker to validate existence; the worker checks again at thread start.
    const existing = yield* sql<{ id: string; root_path: string }>`
            SELECT id, root_path FROM project_workspaces
             WHERE project_id = ${projectId}::uuid AND worker_id = ${workerId}::uuid AND archived_at IS NULL`;

    const key = pathKey(root, style, worker.os);

    if (existing.some((w) => w.id !== input.except && pathKey(w.root_path, style, worker.os) === key)) {
      return yield* Effect.fail(new Invalid(`${root} is already a workspace of this project on this worker`));
    }

    return root;
  });

/** An active workspace of a project the user owns. */
const ownedWorkspace = (sql: SqlClient.SqlClient, ownerUserId: string, workspaceId: string) =>
  Effect.gen(function* () {
    return yield* one(
      yield* sql<{ project_id: string; worker_id: string; root_path: string; label: string }>`
              SELECT w.project_id, w.worker_id, w.root_path, w.label FROM project_workspaces w JOIN projects p ON p.id = w.project_id
               WHERE w.id = ${workspaceId}::uuid AND p.owner_user_id = ${ownerUserId}::uuid AND w.archived_at IS NULL AND p.archived_at IS NULL AND p.kind <> 'scratch'`,
      "workspace",
    );
  });

const listProjects = (sql: SqlClient.SqlClient, ownerUserId: string) =>
  sql.withTransaction(
    Effect.gen(function* () {
      // Provision lazily for existing users too. The owner index and project lock serialize
      // concurrent overview requests; no worker directory is created until CreateThread.
      yield* sql`INSERT INTO projects (id, owner_user_id, name, slug, kind)
            VALUES (${Bun.randomUUIDv7()}::uuid, ${ownerUserId}::uuid, 'No project', 'system-scratch', 'scratch')
            ON CONFLICT (owner_user_id) WHERE kind = 'scratch' DO NOTHING`;

      const scratch = (yield* sql<{
        id: string;
      }>`SELECT id FROM projects WHERE owner_user_id = ${ownerUserId}::uuid AND kind = 'scratch' FOR UPDATE`)[0]!;

      const workers = yield* sql<{ id: string; os: string; capabilities: { scratchRoot?: string } }>`
            SELECT w.id, w.os, w.capabilities FROM workers w JOIN worker_configs c ON c.worker_id = w.id
            WHERE (w.owner_user_id IS NULL OR w.owner_user_id = ${ownerUserId}::uuid)
              AND w.archived_at IS NULL AND w.revoked_at IS NULL`;

      for (const worker of workers) {
        const root = worker.capabilities.scratchRoot;

        if (!root) continue;
        const style = pathStyle(worker.os, root);

        if (!isAbsolutePath(root, style)) continue;
        const base = scratchBase(root, ownerUserId, style);

        const current = (yield* sql<{
          id: string;
          root_path: string;
        }>`SELECT id, root_path FROM project_workspaces
              WHERE project_id = ${scratch.id}::uuid AND worker_id = ${worker.id}::uuid AND archived_at IS NULL`)[0];

        if (!current)
          yield* sql`INSERT INTO project_workspaces (id, project_id, worker_id, root_path)
              VALUES (${Bun.randomUUIDv7()}::uuid, ${scratch.id}::uuid, ${worker.id}::uuid, ${base})`;
        else if (current.root_path !== base)
          yield* sql`UPDATE project_workspaces SET root_path = ${base} WHERE id = ${current.id}::uuid`;
      }

      const projects = yield* sql<{ id: string; name: string; slug: string; kind: string; created_at: Date }>`
            SELECT id, name, slug, kind, created_at FROM projects WHERE owner_user_id = ${ownerUserId}::uuid AND archived_at IS NULL ORDER BY (kind = 'scratch') DESC, created_at`;

      const workspaces = yield* sql<{
        id: string;
        project_id: string;
        worker_id: string;
        root_path: string;
        label: string;
      }>`
            SELECT w.id, w.project_id, w.worker_id, w.root_path, w.label FROM project_workspaces w
              JOIN projects p ON p.id = w.project_id JOIN workers host ON host.id = w.worker_id
             WHERE p.owner_user_id = ${ownerUserId}::uuid AND w.archived_at IS NULL
               AND (p.kind <> 'scratch' OR (host.archived_at IS NULL AND host.revoked_at IS NULL
                 AND (host.owner_user_id IS NULL OR host.owner_user_id = ${ownerUserId}::uuid)
                 AND coalesce(host.capabilities->>'scratchRoot', '') <> ''))
             ORDER BY w.created_at`;

      return projects.map((p) =>
        create(ui.ProjectSchema, {
          ...p,
          createdAt: timestampFromDate(new Date(p.created_at)),
          workspaces: workspaces
            .filter((w) => w.project_id === p.id)
            .map((w) => ({
              id: w.id,
              projectId: w.project_id,
              workerId: w.worker_id,
              rootPath: w.root_path,
              label: w.label,
            })),
        }),
      );
    }),
  );

export function projectStore(sql: SqlClient.SqlClient): ProjectStore {
  return {
    createProject: (ownerUserId, name, shared) =>
      Effect.gen(function* () {
        const trimmed = name.trim();

        if (!trimmed) return yield* Effect.fail(new Invalid("project name is required"));

        if (trimmed.length > 200 || /[\r\n\p{Cc}]/u.test(trimmed))
          return yield* Effect.fail(new Invalid("project name must be one line with 1–200 characters"));
        const id = shared ?? Bun.randomUUIDv7();
        const slug = `${slugify(trimmed)}-${id.slice(-6)}`;
        yield* sql`INSERT INTO projects (id, owner_user_id, name, slug) VALUES (${id}::uuid, ${ownerUserId}::uuid, ${trimmed}, ${slug})`;

        return create(ui.ProjectSchema, { id, name: trimmed, slug, kind: "project", workspaces: [] });
      }),

    lockProject: (ownerUserId, projectId) =>
      Effect.gen(function* () {
        const rows = yield* sql`SELECT id FROM projects WHERE id = ${projectId}::uuid
              AND owner_user_id = ${ownerUserId}::uuid AND kind = 'project' AND archived_at IS NULL FOR UPDATE`;

        if (!rows.length) return yield* Effect.fail(new NotFound("project not found or is system-managed"));
      }),

    renameProject: (ownerUserId, projectId, name) =>
      Effect.gen(function* () {
        const trimmed = name.trim();

        if (!trimmed || trimmed.length > 200 || /[\r\n\p{Cc}]/u.test(trimmed))
          return yield* Effect.fail(new Invalid("project name must be one line with 1–200 characters"));

        const rows = yield* sql`UPDATE projects SET name = ${trimmed} WHERE id = ${projectId}::uuid
              AND owner_user_id = ${ownerUserId}::uuid AND kind = 'project' AND archived_at IS NULL RETURNING id`;

        if (!rows.length) return yield* Effect.fail(new NotFound("project not found or is system-managed"));
      }),

    archiveProject: (ownerUserId, projectId) =>
      Effect.gen(function* () {
        const rows = yield* sql`UPDATE projects SET archived_at = now() WHERE id = ${projectId}::uuid
              AND owner_user_id = ${ownerUserId}::uuid AND kind = 'project' AND archived_at IS NULL RETURNING id`;

        if (!rows.length) return yield* Effect.fail(new NotFound("project not found or is system-managed"));
        yield* sql`UPDATE project_workspaces SET archived_at = coalesce(archived_at, now()) WHERE project_id = ${projectId}::uuid`;
        yield* sql`UPDATE schedules SET status = 'cancelled', next_run_at = NULL, lease_owner = NULL, lease_until = NULL, version = version + 1
              WHERE project_id = ${projectId}::uuid AND status IN ('active', 'paused')`;
      }),

    createWorkspace: ({ projectId, workerId, rootPath, label }) =>
      Effect.gen(function* () {
        const project = yield* one(
          yield* sql<{
            kind: string;
          }>`SELECT kind FROM projects WHERE id = ${projectId}::uuid AND archived_at IS NULL FOR SHARE`,
          "project",
        );

        if (project.kind === "scratch")
          return yield* Effect.fail(new Invalid("scratch workspaces are managed automatically"));
        const root = yield* workspaceRoot(sql, { projectId, workerId, rootPath });
        const id = Bun.randomUUIDv7();
        yield* sql`
                INSERT INTO project_workspaces (id, project_id, worker_id, root_path, label)
                VALUES (${id}::uuid, ${projectId}::uuid, ${workerId}::uuid, ${root}, ${label})`;

        return create(ui.WorkspaceSchema, { id, projectId, workerId, rootPath: root, label });
      }),

    updateWorkspace: (ownerUserId, { workspaceId, rootPath, label }) =>
      Effect.gen(function* () {
        const current = yield* ownedWorkspace(sql, ownerUserId, workspaceId);

        const root =
          rootPath === undefined
            ? current.root_path
            : yield* workspaceRoot(sql, {
                projectId: current.project_id,
                workerId: current.worker_id,
                rootPath,
                except: workspaceId,
              });

        const nextLabel = label ?? current.label;
        yield* sql`UPDATE project_workspaces SET root_path = ${root}, label = ${nextLabel} WHERE id = ${workspaceId}::uuid`;

        return create(ui.WorkspaceSchema, {
          id: workspaceId,
          projectId: current.project_id,
          workerId: current.worker_id,
          rootPath: root,
          label: nextLabel,
        });
      }),

    removeWorkspace: (ownerUserId, workspaceId) =>
      Effect.gen(function* () {
        const current = yield* ownedWorkspace(sql, ownerUserId, workspaceId);
        yield* sql`UPDATE project_workspaces SET archived_at = now() WHERE id = ${workspaceId}::uuid AND archived_at IS NULL`;

        return create(ui.WorkspaceSchema, {
          id: workspaceId,
          projectId: current.project_id,
          workerId: current.worker_id,
          rootPath: current.root_path,
          label: current.label,
        });
      }),

    listProjects: (ownerUserId) => listProjects(sql, ownerUserId),
  };
}

function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "project"
  );
}
