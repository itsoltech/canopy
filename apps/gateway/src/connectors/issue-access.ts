import type { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { uuid } from "../agent-environment/composition.ts";
import { Invalid, NotFound } from "../store/errors.ts";
import { projectConnectorAccess } from "./project-access.ts";

export type IssueScope = Pick<Partial<ui.MentionScope>, "threadId" | "workspaceId">;

export interface IssueAccount {
  id: string;
  name: string;
  provider: "atlassian" | "github" | "linear";
  revision: string;
}

/** Resolve the placement from the owner's active thread or workspace on its home gateway. */
export function issueSources(sql: SqlClient.SqlClient, owner: string, scope?: IssueScope) {
  return Effect.gen(function* () {
    const id = scope?.threadId || scope?.workspaceId;

    if (!id || !uuid(id)) return yield* Effect.fail(new Invalid("Choose a thread or workspace to search issues"));

    const thread = scope?.threadId
      ? sql`JOIN threads t ON t.workspace_id=ws.id AND t.project_id=p.id AND t.worker_id=w.id
          AND t.owner_user_id=p.owner_user_id AND t.runtime='worker' AND t.id=${id}::uuid
          AND t.archived_at IS NULL AND t.deleted_at IS NULL`
      : sql``;

    const placement = (yield* sql<{ project_id: string; git_origin: string; worker_id: string }>`
      SELECT p.id AS project_id,ws.git_origin,w.id AS worker_id FROM project_workspaces ws
      JOIN projects p ON p.id=ws.project_id JOIN workers w ON w.id=ws.worker_id ${thread}
      WHERE p.owner_user_id=${owner}::uuid AND p.archived_at IS NULL AND NOT p.config_deleted
        AND (w.owner_user_id=p.owner_user_id OR w.owner_user_id IS NULL)
        AND w.revoked_at IS NULL AND w.archived_at IS NULL AND ws.archived_at IS NULL
        ${scope?.threadId ? sql`` : sql`AND ws.id=${id}::uuid`}`)[0];

    if (!placement)
      return yield* Effect.fail(new NotFound(scope?.threadId ? "thread not found" : "workspace not found"));

    const accounts = yield* sql<IssueAccount>`SELECT a.id,a.name,a.connector_type AS provider,a.revision::text
      FROM connector_accounts a WHERE a.owner_user_id=${owner}::uuid AND a.status='connected'
        AND a.connector_type IN ('atlassian','github','linear')
        AND ${projectConnectorAccess(sql, owner, placement.project_id, {
          id: sql`a.id`,
          allProjects: sql`a.all_projects`,
          noProject: sql`a.no_project`,
        })}
      ORDER BY a.connector_type,a.name,a.id`;

    return { accounts, placement };
  });
}
