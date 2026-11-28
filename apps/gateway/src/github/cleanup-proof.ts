import { Schema } from "effect";
import type { GitHubAccounts } from "./service.ts";
import { DiscoveredPull } from "./discovery.ts";
import { repositoryName } from "./repository-accounts.ts";
import { cleanupAccess } from "./cleanup-access.ts";

/** Only a repository account granted to this project can supply merge evidence. */
export async function githubCleanupProof(
  accounts: GitHubAccounts,
  owner: string,
  projectId: string,
  name: string,
  branch: string,
  head: string,
  signal?: AbortSignal,
) {
  if (owner !== accounts.owner || !branch || !/^[0-9a-f]{40,64}$/.test(head)) return false;

  try {
    repositoryName(name);
    const access = await cleanupAccess(accounts, projectId, name);

    if (!access) return false;
    const params = new URLSearchParams({ state: "closed", head: `${name.split("/")[0]}:${branch}`, per_page: "100" });
    const path = `/repositories/${access.repositoryId}/pulls`;

    const matches = (pull: DiscoveredPull) =>
      pull.head.ref === branch &&
      pull.head.sha === head &&
      String(pull.head.repo?.id) === access.repositoryId &&
      String(pull.base.repo.id) === access.repositoryId &&
      pull.base.repo.full_name.toLowerCase() === name.toLowerCase();

    const result = await accounts.prs.client.read(
      access.accountId,
      {
        key: `cleanup:${access.repositoryId}:${branch}:${head}`,
        path: `${path}?${params}`,
        ...(signal && { signal }),
      },
      true,
    );

    const pulls = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(DiscoveredPull) }))(
      result.payload,
    ).items;

    for (const pull of pulls) {
      if (!pull.merged_at || !matches(pull)) continue;

      const detail = await accounts.prs.client.read(
        access.accountId,
        {
          key: `cleanup-pr:${access.repositoryId}:${pull.number}:${head}`,
          path: `${path}/${pull.number}`,
          ...(signal && { signal }),
        },
        true,
      );

      const verified = Schema.decodeUnknownSync(Schema.Struct({ merged: Schema.Boolean, ...DiscoveredPull.fields }))(
        detail.payload,
      );

      if (verified.merged && verified.number === pull.number && matches(verified) && (await access.isCurrent()))
        return true;
    }
  } catch {
    // No fresh authorized proof: retain the independent git checks and local-change protections.
  }

  return false;
}
