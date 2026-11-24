import { Schema } from "effect";
import type { github } from "@canopy/contracts";
import { SUMMARY_QUERY } from "./pull-request-query.ts";
import type { GitHubPullRequests } from "./pull-requests.ts";
import { githubFailure } from "./http.ts";
import { refreshReason } from "./last-known.ts";
import { Code } from "@connectrpc/connect";

/** Four full summaries per request bounds GitHub's nested connection cost and response size. */
const batchSize = 4;

function query(refs: readonly github.PullRequestRef[]) {
  const repository = SUMMARY_QUERY.slice(SUMMARY_QUERY.indexOf("repository(owner:"), SUMMARY_QUERY.lastIndexOf("}"));

  const fields = refs.map(
    (_, i) =>
      `pr${i}:${repository
        .replaceAll("$owner", `$owner${i}`)
        .replaceAll("$name", `$name${i}`)
        .replaceAll("$number", `$number${i}`)}`,
  );

  const declarations = refs.map((_, i) => `$owner${i}:String!,$name${i}:String!,$number${i}:Int!`);

  return `query CanopyLinkedPullRequests(${declarations.join(",")}){rateLimit{cost remaining resetAt} ${fields.join(" ")}}`;
}

export async function refreshLinkedBatch(prs: GitHubPullRequests, refs: readonly github.PullRequestRef[]) {
  const { run, owner } = prs.accounts;
  const groups = new Map<string, github.PullRequestRef[]>();

  for (const ref of refs) {
    if (!(await run((s) => s.prRefreshClaim(owner, ref.id))).length) continue;

    try {
      const { row } = await prs.repositories.selected(ref.repositoryName);
      const group = groups.get(row.id) ?? [];
      group.push(ref);
      groups.set(row.id, group);
    } catch (cause) {
      const error = githubFailure(cause);
      await run((s) =>
        s.prRefreshFailed(
          owner,
          ref.repositoryName,
          ref.number,
          refreshReason(ref.repositoryName, error),
          error.code === Code.PermissionDenied,
        ),
      );
    }
  }

  for (const [account, group] of groups) {
    for (let start = 0; start < group.length; start += batchSize) {
      const batch = group.slice(start, start + batchSize);
      const variables: Record<string, string | number> = {};
      batch.forEach((ref, i) => {
        variables[`owner${i}`] = ref.repositoryName.split("/")[0]!;
        variables[`name${i}`] = ref.repositoryName.split("/")[1]!;
        variables[`number${i}`] = ref.number;
      });

      try {
        const selected = await prs.repositories.selected(batch[0]!.repositoryName);

        if (selected.row.id !== account) continue;

        const result = await prs.client.read(account, {
          key: `linked-batch:${batch.map((r) => r.id).join(":")}`,
          path: "/graphql",
          query: query(batch),
          variables,
          background: true,
          ttl: 60_000,
        });

        const envelope = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.JsonObject }))(result.payload);

        for (const [i, ref] of batch.entries()) {
          const payload = {
            data: { repository: envelope.data[`pr${i}`] ?? null },
            errors: result.payload?.["errors"] ?? [],
          };

          // load validates identity, access revisions and partial/error envelopes before saving each cache entry.
          await prs
            .load(ref.repositoryName, ref.number, true, true, true, {
              accountId: account,
              revision: BigInt(selected.row.revision),
              payload,
            })
            .then(() => prs.pullRequestChanged(ref.id))
            .catch(() => {});
        }
      } catch (cause) {
        const error = githubFailure(cause);

        for (const ref of batch)
          await run((s) =>
            s.prRefreshFailed(
              owner,
              ref.repositoryName,
              ref.number,
              refreshReason(ref.repositoryName, error),
              error.code === Code.PermissionDenied,
            ),
          );

        // A shared budget/transport failure must not fan out into the remaining batches.
        return;
      }
    }
  }
}
