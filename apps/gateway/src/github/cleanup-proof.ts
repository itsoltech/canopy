import { Schema } from "effect";
import type { GitHubAccounts } from "./service.ts";
import { DiscoveredPull } from "./discovery.ts";
import { repositoryName } from "./repository-accounts.ts";

/** Product sign-in grants no agent/worker access. Only an explicitly granted PAT can supply cleanup proof. */
export async function githubCleanupProof(
  accounts: GitHubAccounts,
  owner: string,
  worker: string,
  name: string,
  branch: string,
  head: string,
) {
  if (owner !== accounts.owner || !branch || !/^[0-9a-f]{40,64}$/.test(head)) return false;

  try {
    repositoryName(name);
    const { mapping, row } = await accounts.prs.repositories.selected(name);

    if (!row.connector_account_id || row.auth_kind !== "pat") return false;

    const granted = () =>
      accounts.run((s) => s.detectionCleanupGrant(owner, row.connector_account_id!, worker, row.connector_revision!));

    if (!(await granted()).length) return false;
    const params = new URLSearchParams({ state: "closed", head: `${name.split("/")[0]}:${branch}`, per_page: "100" });

    const result = await accounts.prs.client.read(
      row.id,
      {
        key: `cleanup:${mapping.repository_id}:${branch}:${head}`,
        path: `/repos/${name}/pulls?${params}`,
      },
      true,
    );

    const pulls = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(DiscoveredPull) }))(
      result.payload,
    ).items;

    for (const pull of pulls) {
      if (
        !pull.merged_at ||
        pull.head.ref !== branch ||
        pull.head.sha !== head ||
        String(pull.head.repo?.id) !== mapping.repository_id ||
        String(pull.base.repo.id) !== mapping.repository_id
      )
        continue;

      const detail = await accounts.prs.client.read(
        row.id,
        {
          key: `cleanup-pr:${mapping.repository_id}:${pull.number}:${head}`,
          path: `/repos/${name}/pulls/${pull.number}`,
        },
        true,
      );

      const verified = Schema.decodeUnknownSync(Schema.Struct({ merged: Schema.Boolean, ...DiscoveredPull.fields }))(
        detail.payload,
      );

      const current = await accounts.prs.repositories.selected(name);

      if (
        verified.merged &&
        verified.head.ref === branch &&
        verified.head.sha === head &&
        String(verified.head.repo?.id) === mapping.repository_id &&
        String(verified.base.repo.id) === mapping.repository_id &&
        current.row.id === row.id &&
        current.row.revision === row.revision &&
        current.mapping.revision === mapping.revision &&
        (await granted()).length
      )
        return true;
    }
  } catch {
    // No fresh authorized proof: retain the independent git checks and local-change protections.
  }

  return false;
}
