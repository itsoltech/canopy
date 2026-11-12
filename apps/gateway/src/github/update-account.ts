import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { GitHubAccounts } from "./service.ts";
import { uuid } from "./records.ts";

export function githubUpdateStore(sql: SqlClient.SqlClient) {
  return {
    updateAccount: (owner: string) =>
      Effect.map(
        sql<{ account_id: string | null; enabled: boolean }>`SELECT account_id,enabled
        FROM github_update_accounts WHERE owner_user_id=${owner}::uuid`,
        (rows) => rows[0],
      ),
    setUpdateAccount: (owner: string, account: string, enabled: boolean) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM github_pr_cache WHERE owner_user_id=${owner}::uuid AND cache_key LIKE 'release:%'`;

          return yield* sql`INSERT INTO github_update_accounts(owner_user_id,account_id,enabled) VALUES (${owner}::uuid,${account || null}::uuid,${enabled})
          ON CONFLICT(owner_user_id) DO UPDATE SET account_id=excluded.account_id,enabled=excluded.enabled`;
        }),
      ),
  };
}

export async function updateAccount(accounts: GitHubAccounts, request?: github.GitHubUpdateAccountRequest) {
  if (request) {
    if (request.enabled || request.accountId) {
      if (!uuid(request.accountId)) throw new ConnectError("Choose an account", Code.InvalidArgument);
      await accounts.run((s) => s.owned(accounts.owner, request.accountId));

      if (request.enabled) {
        const current = await accounts.prs.repositories.get("itsoltech/canopy");
        await accounts.prs.repositories.set(
          create(github.SetGitHubRepositoryAccountRequestSchema, {
            repositoryName: "itsoltech/canopy",
            accountId: request.accountId,
            expectedRevision: current.revision,
          }),
        );
      }
    }

    await accounts.run((s) => s.setUpdateAccount(accounts.owner, request.accountId, request.enabled));
    accounts.prs.client.memory.clear();
  }

  const value = await accounts.run((s) => s.updateAccount(accounts.owner));
  const resolved = await accounts.prs.repositories.cached("itsoltech/canopy");

  return create(github.GitHubUpdateAccountResponseSchema, {
    accountId: resolved?.row.id ?? "",
    enabled: value?.enabled ?? true,
  });
}
