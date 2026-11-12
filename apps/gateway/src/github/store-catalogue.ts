import { Array, Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { AccountRow } from "./records.ts";
import type { Installation, Repository } from "./schemas.ts";

export interface InstallationRow {
  installation_id: string;
  login: string;
  account_type: string;
  repository_selection: string;
  permissions: Record<string, string>;
  suspended: boolean;
  verified_at: Date;
}

export interface RepositoryRow {
  repository_id: string;
  full_name: string;
  private: boolean;
  permissions: Record<string, boolean>;
}

export function githubCatalogue(sql: SqlClient.SqlClient) {
  return {
    catalogueCounts: (owner: string, account: string) =>
      sql<{ installations: number; repositories: number }>`SELECT
        (SELECT count(*)::integer FROM github_installations WHERE owner_user_id=${owner}::uuid AND account_id=${account}::uuid) AS installations,
        (SELECT count(*)::integer FROM github_installation_repositories WHERE owner_user_id=${owner}::uuid AND account_id=${account}::uuid) AS repositories`,
    repositoryCount: (owner: string, account: string, installation: string) =>
      sql<{ total: number }>`SELECT count(*)::integer AS total FROM github_installation_repositories
        WHERE owner_user_id=${owner}::uuid AND account_id=${account}::uuid AND installation_id=${installation}`,
    saveCatalogue: (
      row: AccountRow,
      catalogue: readonly { installation: Installation; repos: readonly Repository[] }[],
      now: number,
      fingerprint: string,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const owned = yield* sql<{
            catalog_fingerprint: string;
          }>`SELECT catalog_fingerprint FROM github_accounts WHERE owner_user_id=${row.owner_user_id}::uuid
          AND id=${row.id}::uuid AND status='connected' AND revision=${row.revision}::bigint FOR UPDATE`;

          if (!owned[0]) return undefined;
          const changed = owned[0].catalog_fingerprint !== fingerprint;
          yield* sql`DELETE FROM github_installations WHERE owner_user_id=${row.owner_user_id}::uuid AND account_id=${row.id}::uuid`;

          for (const { installation: i, repos } of catalogue) {
            yield* sql`INSERT INTO github_installations
            (owner_user_id,account_id,installation_id,login,account_type,repository_selection,permissions,suspended,verified_at)
            VALUES (${row.owner_user_id}::uuid,${row.id}::uuid,${String(i.id)},${i.account.login},${i.account.type},
            ${i.repository_selection},${JSON.stringify(i.permissions)}::jsonb,${i.suspended_at !== null},${new Date(now)})`;

            // Bulk INSERT keeps large catalogues off a per-repository SQL round-trip path.
            const values = repos.map((r) => ({
              owner_user_id: row.owner_user_id,
              account_id: row.id,
              installation_id: String(i.id),
              repository_id: String(r.id),
              full_name: r.full_name,
              private: r.private,
              permissions: JSON.stringify(r.permissions ?? {}),
              verified_at: new Date(now),
            }));

            if (Array.isArrayNonEmpty(values))
              yield* sql`INSERT INTO github_installation_repositories ${sql.insert(values)}`;
          }

          yield* sql`UPDATE github_accounts SET catalog_verified_at=${new Date(now)},catalog_fingerprint=${fingerprint},
            revision=revision+${changed ? 1 : 0}
            WHERE owner_user_id=${row.owner_user_id}::uuid AND id=${row.id}::uuid`;

          if (changed)
            yield* sql`DELETE FROM github_pr_cache WHERE owner_user_id=${row.owner_user_id}::uuid AND account_id=${row.id}::uuid`;

          return { changed };
        }),
      ),
    installations: (owner: string, account: string, page: number) =>
      sql<InstallationRow>`SELECT * FROM github_installations WHERE owner_user_id=${owner}::uuid
        AND account_id=${account}::uuid ORDER BY login,installation_id LIMIT 51 OFFSET ${page * 50}`,
    repositories: (owner: string, account: string, installation: string, page: number) =>
      sql<RepositoryRow>`SELECT * FROM github_installation_repositories WHERE owner_user_id=${owner}::uuid
        AND account_id=${account}::uuid AND installation_id=${installation} ORDER BY full_name,repository_id LIMIT 51 OFFSET ${page * 50}`,
  };
}
