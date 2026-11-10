import { create, toJson } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Option, Schema } from "effect";

const person = Schema.NullOr(Schema.Struct({ login: Schema.String }));
const page = Schema.Struct({ hasNextPage: Schema.Boolean });

const check = Schema.Struct({
  __typename: Schema.String,
  name: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.String),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
  creator: Schema.optional(person),
  checkSuite: Schema.optional(Schema.Struct({ app: Schema.NullOr(Schema.Struct({ name: Schema.String })) })),
});

const PullRequest = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  body: Schema.NullOr(Schema.String),
  author: person,
  updatedAt: Schema.String,
  createdAt: Schema.String,
  baseRefName: Schema.String,
  headRefName: Schema.String,
  baseRefOid: Schema.String,
  headRefOid: Schema.String,
  changedFiles: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
  labels: Schema.NullOr(
    Schema.Struct({
      nodes: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.String })),
      pageInfo: page,
    }),
  ),
  assignees: Schema.NullOr(
    Schema.Struct({ nodes: Schema.Array(Schema.Struct({ login: Schema.String })), pageInfo: page }),
  ),
  reviewRequests: Schema.NullOr(
    Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          requestedReviewer: Schema.NullOr(
            Schema.Struct({
              login: Schema.optional(Schema.String),
              name: Schema.optional(Schema.String),
              slug: Schema.optional(Schema.String),
            }),
          ),
        }),
      ),
      pageInfo: page,
    }),
  ),
  latestReviews: Schema.NullOr(
    Schema.Struct({
      nodes: Schema.Array(Schema.Struct({ author: person, state: Schema.String })),
      pageInfo: page,
    }),
  ),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({
          oid: Schema.String,
          statusCheckRollup: Schema.NullOr(
            Schema.Struct({
              state: Schema.String,
              contexts: Schema.Struct({ nodes: Schema.Array(check), pageInfo: page, totalCount: Schema.Number }),
            }),
          ),
        }),
      }),
    ),
  }),
});

const Envelope = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      repository: Schema.NullOr(Schema.Struct({ databaseId: Schema.Number, pullRequest: Schema.NullOr(PullRequest) })),
    }),
  ),
  errors: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String) }))),
});

export const SUMMARY_QUERY = `query CanopyPullRequest($owner:String!,$name:String!,$number:Int!){
  rateLimit { cost remaining resetAt }
  repository(owner:$owner,name:$name){ databaseId pullRequest(number:$number){
    id number title state isDraft body author{login} updatedAt createdAt
    baseRefName headRefName baseRefOid headRefOid changedFiles additions deletions
    labels(first:100){nodes{name color} pageInfo{hasNextPage}}
    assignees(first:100){nodes{login} pageInfo{hasNextPage}}
    reviewRequests(first:100){nodes{requestedReviewer{... on User{login} ... on Team{name slug}}} pageInfo{hasNextPage}}
    latestReviews(first:100){nodes{author{login} state} pageInfo{hasNextPage}}
    commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){totalCount pageInfo{hasNextPage}
      nodes{__typename ... on CheckRun{name status conclusion detailsUrl checkSuite{app{name}}}
      ... on StatusContext{context state targetUrl creator{login}}}}}}}}
  }}
}`;

export const pullRequestCreatedAt = (value: Schema.JsonObject) =>
  // SAFETY: summarySnapshot validated the complete identity before this accessor is called.
  new Date(Schema.decodeUnknownSync(Envelope)(value).data!.repository!.pullRequest!.createdAt);

/** Field failures keep the previous verified summary; permission failures never preserve private content. */
export function partialSnapshot(value: Schema.JsonObject, previous?: github.PullRequestSnapshot) {
  const errors = Schema.decodeUnknownOption(
    Schema.Struct({ errors: Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String) })) }),
  )(value);

  const items = Option.getOrUndefined(errors)?.errors;

  if (items?.some((e) => ["FORBIDDEN", "NOT_FOUND"].includes(e.type ?? "")))
    throw new ConnectError("GitHub access is unavailable. Check repository permissions.", Code.PermissionDenied);

  if (previous && items?.length && Option.isNone(Schema.decodeUnknownOption(Envelope)(value)))
    return create(github.PullRequestSnapshotSchema, {
      ...previous,
      stale: true,
      completeness: "partial",
      detail: "Some GitHub details are unavailable. Refresh to retry, or open on GitHub.",
    });

  return undefined;
}

export function summarySnapshot(
  value: Schema.JsonObject,
  repositoryId: string,
  repositoryName: string,
  number: number,
  now: number,
  previous?: github.PullRequestSnapshot,
) {
  const parsed = Schema.decodeUnknownSync(Envelope)(value);
  const repo = parsed.data?.repository;
  const pr = repo?.pullRequest;

  if (!pr || String(repo?.databaseId) !== repositoryId || pr.number !== number)
    throw new ConnectError(
      "This pull request is not available to this account. Check its repository access.",
      Code.PermissionDenied,
    );

  const rollup =
    pr.commits.nodes[0]?.commit.oid === pr.headRefOid ? pr.commits.nodes[0]?.commit.statusCheckRollup : undefined;

  const checks = (rollup?.contexts.nodes ?? []).map((c) => ({
    name: c.name ?? c.context ?? "Check",
    state: (c.conclusion || c.status || c.state || "unknown").toLowerCase(),
    provider: c.checkSuite?.app?.name ?? c.creator?.login ?? "",
    url: c.detailsUrl ?? c.targetUrl ?? "",
    headSha: pr.headRefOid,
  }));

  const partial =
    !!parsed.errors?.length ||
    [pr.labels, pr.assignees, pr.reviewRequests, pr.latestReviews].some((v) => !v || v.pageInfo.hasNextPage) ||
    pr.body === null ||
    !!rollup?.contexts.pageInfo.hasNextPage;

  const snapshot = create(github.PullRequestSnapshotSchema, {
    summary: {
      ref: { host: "github.com", repositoryId, repositoryName, number, nodeId: pr.id },
      title: pr.title,
      state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
      headSha: pr.headRefOid,
      checksState: rollup?.state.toLowerCase() ?? "unavailable",
      checksCount: rollup?.contexts.totalCount ?? 0,
      updatedAt: timestampFromDate(new Date(pr.updatedAt)),
      verifiedAt: timestampFromDate(new Date(now)),
    },
    author: pr.author?.login ?? "Deleted user",
    body: pr.body ?? previous?.body ?? "",
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    baseSha: pr.baseRefOid,
    files: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    labels: pr.labels?.nodes.map((l) => l.name) ?? previous?.labels ?? [],
    labelDetails:
      pr.labels?.nodes.map((l) => ({ name: l.name, color: /^[0-9a-f]{6}$/i.test(l.color) ? l.color : "" })) ??
      previous?.labelDetails ??
      [],
    assignees: pr.assignees?.nodes.map((a) => a.login) ?? previous?.assignees ?? [],
    reviewers: [
      ...(pr.reviewRequests?.nodes.flatMap((r) =>
        r.requestedReviewer
          ? [
              {
                login: r.requestedReviewer.login ?? r.requestedReviewer.slug ?? r.requestedReviewer.name ?? "",
                state: "requested",
              },
            ]
          : [],
      ) ??
        previous?.reviewers.filter((r) => r.state === "requested") ??
        []),
      ...(pr.latestReviews?.nodes.map((r) => ({
        login: r.author?.login ?? "Deleted user",
        state: r.state.toLowerCase(),
      })) ??
        previous?.reviewers.filter((r) => r.state !== "requested") ??
        []),
    ],
    checks,
    completeness: partial ? "partial" : "complete",
    detail: partial ? "Some GitHub details are unavailable. Open on GitHub for the full summary." : "",
  });

  if (
    Buffer.byteLength(snapshot.body) > 65_536 ||
    Buffer.byteLength(JSON.stringify(toJson(github.PullRequestSnapshotSchema, snapshot))) > 131_072
  )
    throw new ConnectError("This summary is too large. Open the pull request on GitHub.", Code.ResourceExhausted);

  return snapshot;
}
