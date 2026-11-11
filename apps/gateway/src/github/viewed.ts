import { Schema } from "effect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GitHubPullRequests } from "./pull-requests.ts";
import type { AccountRow } from "./records.ts";
import type { PullRequestRow } from "./store-pull-requests.ts";
import { graphErrors } from "./read-scope.ts";

export const VIEWED_QUERY = `query CanopyViewed($owner:String!,$name:String!,$number:Int!,$after:String){rateLimit{cost remaining resetAt}
repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid baseRefOid files(first:100,after:$after){
pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}`;

const response = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            headRefOid: Schema.String,
            baseRefOid: Schema.String,
            files: Schema.NullOr(
              Schema.Struct({
                nodes: Schema.Array(
                  Schema.Struct({
                    path: Schema.String,
                    viewerViewedState: Schema.Literals(["VIEWED", "UNVIEWED", "DISMISSED"]),
                  }),
                ),
                pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
});

/** Join REST and GraphQL by path and both SHAs. Never infer Viewed from a local checkbox. */
export async function viewedFiles(
  prs: GitHubPullRequests,
  row: AccountRow,
  pr: PullRequestRow,
  head: string,
  base: string,
  refresh = false,
) {
  const states = new Map<string, string>();
  let after = "";
  let complete = false;

  for (let page = 0; page < 30; page++) {
    const value = await prs.client.read(
      row.id,
      {
        key: `viewed:${pr.id}:${base}:${head}:${page}`,
        path: "/graphql",
        query: VIEWED_QUERY,
        ttl: 60_000,
        variables: {
          owner: pr.repository_name.split("/")[0]!,
          name: pr.repository_name.split("/")[1]!,
          number: pr.number,
          ...(after && { after }),
        },
      },
      refresh,
    );

    if (!value.payload || graphErrors(value.payload))
      throw new ConnectError("Couldn't load Viewed. Refresh the files.", Code.Unavailable);
    const current = Schema.decodeUnknownSync(response)(value.payload).data.repository?.pullRequest;

    if (current?.id !== pr.node_id || current.headRefOid !== head || current.baseRefOid !== base)
      throw new ConnectError("Changes updated. Refresh the files.", Code.FailedPrecondition);

    if (!current.files) throw new ConnectError("Couldn't load Viewed. Refresh the files.", Code.Unavailable);

    for (const file of current.files.nodes) states.set(file.path, file.viewerViewedState);

    if (!current.files.pageInfo.hasNextPage) {
      complete = true;
      break;
    }

    const next = current.files.pageInfo.endCursor;

    if (!next || next === after) break;
    after = next;
  }

  return { states, complete, count: [...states.values()].filter((s) => s === "VIEWED").length };
}
