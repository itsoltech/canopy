import type { github } from "@canopy/contracts";
import { Schema } from "effect";
import type { GatewayCore } from "../core/core.ts";
import { DiscoveredPull } from "./discovery.ts";
import type { MutationRow } from "./store-mutations.ts";

/** A rejected create may suggest a verified PR; only a separate manual link restores a tombstone. */
export async function suggestExisting(core: GatewayCore, row: MutationRow, r: github.PullRequestMutationRequest) {
  if (row.state !== "failed" || row.existing_pr) return row;

  const params = new URLSearchParams({
    state: "open",
    head: `${r.headRepositoryName.split("/")[0]}:${r.headRef}`,
    base: r.baseRef,
    per_page: "100",
  });

  const result = await core.github.prs.client.read(
    r.accountId,
    {
      key: `create-existing:${r.clientRequestId}`,
      path: `/repos/${r.repositoryName}/pulls?${params}`,
      ttl: 0,
    },
    true,
  );

  const candidates = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(DiscoveredPull) }))(
    result.payload,
  ).items;

  const match = candidates.find(
    (pr) =>
      pr.state === "open" &&
      pr.head.sha === r.headSha &&
      pr.head.ref === r.headRef &&
      pr.head.repo?.full_name.toLowerCase() === r.headRepositoryName.toLowerCase() &&
      pr.base.ref === r.baseRef &&
      String(pr.base.repo.id) === row.repository_id,
  );

  if (!match) return row;
  const snapshot = await core.github.prs.load(r.repositoryName, match.number, true);
  const ref = snapshot.summary?.ref;

  if (
    !ref ||
    snapshot.accountId !== r.accountId ||
    snapshot.accessRevision !== r.accessRevision ||
    ref.repositoryId !== row.repository_id ||
    snapshot.headRepositoryName.toLowerCase() !== r.headRepositoryName.toLowerCase() ||
    snapshot.headRef !== r.headRef ||
    snapshot.baseRef !== r.baseRef ||
    snapshot.summary?.headSha !== r.headSha ||
    !["open", "draft"].includes(snapshot.summary.state)
  )
    return row;

  return (await core.github.run((s) => s.mutationExisting(row, ref)))[0] ?? row;
}
