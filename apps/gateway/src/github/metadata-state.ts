import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { digest, graphErrors } from "./read-scope.ts";

const User = Schema.Struct({ id: Schema.String, login: Schema.String });
const Label = Schema.Struct({ id: Schema.String, name: Schema.String, color: Schema.String });

const Reviewer = Schema.Struct({
  id: Schema.String,
  login: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  organization: Schema.optional(Schema.Struct({ login: Schema.String })),
});

const page = Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) });

export const MetadataRepository = Schema.Struct({
  databaseId: Schema.Number,
  viewerPermission: Schema.NullOr(Schema.String),
  pullRequest: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      body: Schema.String,
      viewerCanUpdate: Schema.Boolean,
      author: Schema.NullOr(Schema.Struct({ id: Schema.optional(Schema.String), login: Schema.String })),
      reviewRequests: Schema.Struct({
        nodes: Schema.Array(Schema.Struct({ requestedReviewer: Schema.NullOr(Reviewer) })),
        pageInfo: page,
      }),
      assignees: Schema.Struct({ nodes: Schema.Array(User), pageInfo: page }),
      labels: Schema.Struct({ nodes: Schema.Array(Label), pageInfo: page }),
    }),
  ),
});

export const METADATA_QUERY = `query CanopyMetadata($owner:String!,$name:String!,$number:Int!,$reviewers:String,$assignees:String,$labels:String){
rateLimit{cost remaining resetAt} repository(owner:$owner,name:$name){databaseId viewerPermission
pullRequest(number:$number){id title body viewerCanUpdate author{login ... on User{id}}
reviewRequests(first:100,after:$reviewers){nodes{requestedReviewer{... on User{id login} ... on Team{id slug organization{login}}}} pageInfo{hasNextPage endCursor}}
assignees(first:100,after:$assignees){nodes{id login} pageInfo{hasNextPage endCursor}}
labels(first:100,after:$labels){nodes{id name color} pageInfo{hasNextPage endCursor}}}}}`;

export function metadataData(value: Schema.JsonObject, repository: string, id: string) {
  if (graphErrors(value)) throw new ConnectError("Could not load these fields. Refresh to retry.", Code.Unavailable);

  const repo = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.Struct({ repository: Schema.NullOr(MetadataRepository) }) }),
  )(value).data.repository;

  if (!repo || String(repo.databaseId) !== repository || repo.pullRequest?.id !== id)
    throw new ConnectError("Pull request not found", Code.NotFound);

  return repo;
}

export function metadataView(repo: typeof MetadataRepository.Type) {
  // SAFETY: metadataData verified the PR before projection.
  const pr = repo.pullRequest!;

  const reviewers = pr.reviewRequests.nodes.flatMap(({ requestedReviewer: r }) =>
    r
      ? [
          {
            id: r.id,
            name: r.login ?? `${r.organization?.login}/${r.slug}`,
            kind: r.login ? "user" : "team",
          },
        ]
      : [],
  );

  const assignees = pr.assignees.nodes.map((u) => ({ id: u.id, name: u.login, kind: "user" }));

  const labels = pr.labels.nodes.map((l) => ({
    ...l,
    kind: "label",
    color: /^[a-f0-9]{6}$/i.test(l.color) ? l.color : "",
  }));

  const writable = ["ADMIN", "MAINTAIN", "WRITE"].includes(repo.viewerPermission ?? "");

  return create(github.PullRequestMetadataSchema, {
    title: pr.title,
    body: pr.body,
    revision: digest(
      JSON.stringify([
        pr.id,
        pr.title,
        pr.body,
        reviewers.map((v) => v.id).sort(),
        assignees.map((v) => v.id).sort(),
        labels.map((v) => v.id).sort(),
      ]),
    ),
    reviewers,
    assignees,
    labels,
    actions: [...(pr.viewerCanUpdate ? ["details"] : []), ...(writable ? ["reviewers", "assignees", "labels"] : [])],
  });
}
