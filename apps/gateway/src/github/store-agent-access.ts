import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { installedRepositories } from "./installed-repositories.ts";
import { projectIds } from "../config-sync/project-aliases.ts";
import { replaceProjectAccess } from "../connectors/project-access.ts";
import { ConnectorFailure } from "../connectors/records.ts";
import { lockModuleAdmission } from "../store/module-access.ts";
import { notFound } from "./records.ts";

type Repository = Pick<github.GetGitHubAgentAccessRequest, "accountId" | "repositoryId" | "repositoryName">;

type Installed = { repository_id: string; full_name: string; selected: boolean };

type Stored = { id: string; revision: bigint; github_allow_writes: boolean };

export const agentAccessConflict = () =>
  new ConnectError("Agent access changed. Reload it and try again.", Code.Aborted);

const denied = () =>
  new ConnectError(
    "Check the GitHub installation and the account selected for this repository.",
    Code.PermissionDenied,
  );

function snapshot(sql: SqlClient.SqlClient, owner: string, request: Repository, lock: boolean) {
  return Effect.gen(function* () {
    const { accountId, repositoryName, repositoryId } = request;

    const owned = yield* sql`SELECT id FROM github_accounts WHERE owner_user_id=${owner}::uuid AND id=${accountId}::uuid
      ${lock ? sql`FOR UPDATE` : sql`FOR SHARE`}`;

    if (!owned.length) return yield* Effect.fail(notFound());

    const [installed] = yield* sql<Installed>`SELECT * FROM (${installedRepositories(sql, owner, accountId)}) r
      WHERE repository_id=${repositoryId} AND lower(full_name)=lower(${repositoryName})`;

    const [row] = yield* sql<Stored>`SELECT id, revision, github_allow_writes FROM connector_accounts
      WHERE owner_user_id=${owner}::uuid AND github_account_id=${accountId}::uuid AND github_repository_id=${repositoryId}
        AND (${!!installed} OR lower(github_repository_name)=lower(${repositoryName}))
      ${lock ? sql`FOR UPDATE` : sql`FOR SHARE`}`;

    const result = create(github.GitHubAgentAccessResponseSchema);

    if (row) {
      const aliases = yield* projectIds(sql, owner);

      const projects = yield* sql<{
        project_id: string;
      }>`SELECT project_id FROM connector_project_grants WHERE account_id=${row.id}::uuid ORDER BY project_id`;

      const bots = yield* sql<{
        bot_id: string;
      }>`SELECT g.bot_id FROM connector_bot_grants g JOIN bots b ON b.id=g.bot_id
        WHERE g.account_id=${row.id}::uuid AND b.deleted_at IS NULL ORDER BY g.bot_id`;

      result.revision = BigInt(row.revision);
      result.allowWrites = row.github_allow_writes;
      result.projectIds = [...new Set(projects.map((p) => aliases.toLocal(p.project_id)))];
      result.botIds = bots.map((b) => b.bot_id);
    }

    return { row, installed, result };
  });
}

export function expandsAgentAccess(
  request: github.SetGitHubAgentAccessRequest,
  previous: github.GitHubAgentAccessResponse,
) {
  return (
    (request.allowWrites && !previous.allowWrites && !!(request.projectIds.length || request.botIds.length)) ||
    request.projectIds.some((id) => !previous.projectIds.includes(id)) ||
    request.botIds.some((id) => !previous.botIds.includes(id))
  );
}

export function githubAgentAccessStore(sql: SqlClient.SqlClient) {
  return {
    agentAccess: (owner: string, request: Repository) =>
      sql.withTransaction(snapshot(sql, owner, request, false)).pipe(Effect.map((state) => state.result)),
    agentConnector: (owner: string, connectorId: string, revision: bigint) =>
      sql<{ github_account_id: string }>`SELECT github_account_id FROM connector_accounts
        WHERE owner_user_id=${owner}::uuid AND id=${connectorId}::uuid AND revision=${revision}
          AND connector_type='github_repository' AND status='connected'`,
    agentBinding: (owner: string, accountId: string, connectorId: string, revision: bigint) =>
      sql<{ repository_id: string; full_name: string; account_revision: bigint; github_allow_writes: boolean }>`
        SELECT r.repository_id,r.full_name,a.revision AS account_revision,c.github_allow_writes FROM
          (${installedRepositories(sql, owner, accountId)}) r
        JOIN connector_accounts c ON c.github_repository_id=r.repository_id AND c.github_account_id=${accountId}::uuid
        JOIN github_accounts a ON a.id=c.github_account_id
        WHERE r.selected AND c.id=${connectorId}::uuid AND c.owner_user_id=${owner}::uuid AND c.revision=${revision}
          AND c.status='connected'`,
    setAgentAccess: (owner: string, request: github.SetGitHubAgentAccessRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* lockModuleAdmission(sql, owner);
          const { row, installed, result } = yield* snapshot(sql, owner, request, true);

          if (result.revision !== request.expectedRevision) return yield* Effect.fail(agentAccessConflict());

          if (expandsAgentAccess(request, result) && !installed?.selected) return yield* Effect.fail(denied());
          const botIds = [...new Set(request.botIds)];
          const allowWrites = request.allowWrites && !!(request.projectIds.length || botIds.length);

          if (!row && !request.projectIds.length && !botIds.length) return result;
          const id = row?.id ?? Bun.randomUUIDv7();

          if (!row) {
            if (!installed) return yield* Effect.fail(denied());
            yield* sql`INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,status,
              github_account_id,github_repository_id,github_repository_name,github_allow_writes)
            VALUES (${id}::uuid,${owner}::uuid,'github_repository',${installed.full_name},${"github_" + id.replaceAll("-", "")},
              'https://api.github.com','http','github_app','connected',${request.accountId}::uuid,${installed.repository_id},
              ${installed.full_name},${allowWrites})`;
          } else {
            yield* sql`UPDATE connector_accounts SET revision=revision+1,updated_at=now(),github_allow_writes=${allowWrites},
            name=COALESCE(${installed?.full_name ?? null},name),github_repository_name=COALESCE(${installed?.full_name ?? null},github_repository_name)
            WHERE id=${id}::uuid`;
          }

          yield* replaceProjectAccess(sql, { id, owner_user_id: owner }, false, request.projectIds).pipe(
            Effect.mapError((e) =>
              e instanceof ConnectorFailure
                ? new ConnectError("Choose projects from this account.", Code.InvalidArgument)
                : e,
            ),
          );

          const bots = yield* sql`SELECT id FROM bots WHERE owner_user_id=${owner}::uuid AND id=ANY(${botIds}::uuid[])
          AND deleted_at IS NULL AND (archived_at IS NULL OR id=ANY(${result.botIds}::uuid[])) FOR UPDATE`;

          if (bots.length !== botIds.length)
            return yield* Effect.fail(new ConnectError("Choose bots from this account.", Code.InvalidArgument));
          yield* sql`DELETE FROM connector_bot_grants WHERE account_id=${id}::uuid`;
          yield* sql`INSERT INTO connector_bot_grants(account_id,bot_id) SELECT ${id}::uuid,unnest(${botIds}::uuid[])`;
          yield* sql`UPDATE bots SET revision=revision+1 WHERE id=ANY(${[...result.botIds, ...botIds]}::uuid[]) AND owner_user_id=${owner}::uuid`;
          yield* sql`INSERT INTO connector_audit(owner_user_id,account_id,tool,outcome) VALUES (${owner}::uuid,${id}::uuid,'access','updated')`;

          return (yield* snapshot(sql, owner, request, true)).result;
        }),
      ),
  };
}
