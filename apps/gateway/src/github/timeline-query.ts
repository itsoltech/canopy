import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { github } from "@canopy/contracts";
import { Schema } from "effect";
import { graphErrors, jsonMessage, type ReadScope } from "./read-scope.ts";

export const graphPage = Schema.Struct({
  hasNextPage: Schema.Boolean,
  hasPreviousPage: Schema.optional(Schema.Boolean),
  endCursor: Schema.NullOr(Schema.String),
  startCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const person = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const commit = Schema.Struct({
  oid: Schema.String,
  messageHeadline: Schema.String,
  committedDate: Schema.String,
  url: Schema.String,
  author: Schema.NullOr(Schema.Struct({ name: Schema.String, user: Schema.optional(person) })),
});

const event = Schema.Struct({
  __typename: Schema.String,
  id: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  author: Schema.optional(person),
  actor: Schema.optional(person),
  commit: Schema.optional(commit),
  label: Schema.optional(Schema.Struct({ name: Schema.String })),
});

const envelope = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      repository: Schema.NullOr(
        Schema.Struct({
          pullRequest: Schema.NullOr(
            Schema.Struct({
              id: Schema.String,
              timelineItems: Schema.NullOr(
                Schema.Struct({
                  nodes: Schema.Array(Schema.NullOr(event)),
                  pageInfo: graphPage,
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});

const eventFields = `... on ClosedEvent{id createdAt actor{login} url}
... on ReopenedEvent{id createdAt actor{login}} ... on MergedEvent{id createdAt actor{login} url}
... on ReadyForReviewEvent{id createdAt actor{login}} ... on ConvertToDraftEvent{id createdAt actor{login}}
... on LabeledEvent{id createdAt actor{login} label{name}} ... on UnlabeledEvent{id createdAt actor{login} label{name}}
... on ReviewRequestedEvent{id createdAt actor{login}} ... on ReviewRequestRemovedEvent{id createdAt actor{login}}
... on HeadRefForcePushedEvent{id createdAt actor{login}} ... on BaseRefChangedEvent{id createdAt actor{login}}
... on HeadRefDeletedEvent{id createdAt actor{login}} ... on RenamedTitleEvent{id createdAt actor{login}}
... on AssignedEvent{id createdAt actor{login}} ... on UnassignedEvent{id createdAt actor{login}}`;

export const TIMELINE_QUERY = `query CanopyTimeline($owner:String!,$name:String!,$number:Int!,$before:String,$after:String,$first:Int,$last:Int){
rateLimit{cost remaining resetAt} repository(owner:$owner,name:$name){pullRequest(number:$number){id
timelineItems(first:$first,last:$last,before:$before,after:$after){pageInfo{hasNextPage hasPreviousPage startCursor endCursor}
nodes{__typename ... on IssueComment{id author{login} body url createdAt}
... on PullRequestReview{id author{login} body url createdAt state}
... on PullRequestCommit{commit{oid messageHeadline committedDate url author{name user{login}}}}
${eventFields}}}}}}`;

function item(value: typeof event.Type, index: number, scope: ReadScope) {
  const c = value.commit;

  const kind = c
    ? "commit"
    : value.__typename === "IssueComment"
      ? "comment"
      : value.__typename === "PullRequestReview"
        ? "review"
        : "event";

  const entry = create(github.PullRequestTimelineEntrySchema, {
    id: value.id ?? c?.oid ?? `${scope.position}:${index}:${value.__typename}`,
    author: value.author?.login ?? value.actor?.login ?? c?.author?.user?.login ?? c?.author?.name ?? "GitHub",
    body: value.body ?? c?.messageHeadline ?? value.label?.name ?? "",
    kind: value.__typename,
    url: value.url ?? c?.url ?? `https://github.com/${scope.pr.repository_name}/pull/${scope.pr.number}`,
    state: value.state?.toLowerCase() ?? "",
    sha: c?.oid ?? "",
    createdAt:
      value.createdAt || c?.committedDate
        ? timestampFromDate(new Date(value.createdAt ?? c!.committedDate))
        : undefined,
  });

  return create(github.PullRequestTimelineItemSchema, { content: { case: kind, value: entry } });
}

export async function timeline(scope: ReadScope) {
  const { request } = scope;

  return scope.read(github.PullRequestTimelinePageSchema, {
    path: "/graphql",
    query: TIMELINE_QUERY,
    variables: {
      ...scope.variables,
      ...(request.oldestFirst
        ? { first: 50, ...(scope.position && { after: scope.position }) }
        : { last: 50, ...(scope.position && { before: scope.position }) }),
    },
    project: async (value) => {
      const partial = graphErrors(value);
      const pr = Schema.decodeUnknownSync(envelope)(value).data?.repository?.pullRequest;

      if (!pr || pr.id !== scope.pr.node_id || !pr.timelineItems)
        return jsonMessage(
          github.PullRequestTimelinePageSchema,
          create(github.PullRequestTimelinePageSchema, {
            page: scope.page(scope.position, true, "Some events are unavailable. Retry to load this page."),
          }),
        );
      const connection = pr.timelineItems;
      const nodes = request.oldestFirst ? connection.nodes : [...connection.nodes].reverse();

      const items = nodes
        .flatMap((node, i) => (node ? [item(node, i, scope)] : []))
        .filter(
          (entry) =>
            (!request.kind || entry.content.case === request.kind) &&
            (!request.author || entry.content.value?.author.toLowerCase() === request.author.toLowerCase()),
        );

      const more = request.oldestFirst ? connection.pageInfo.hasNextPage : connection.pageInfo.hasPreviousPage;

      const next = more
        ? ((request.oldestFirst ? connection.pageInfo.endCursor : connection.pageInfo.startCursor) ?? "")
        : "";

      return jsonMessage(
        github.PullRequestTimelinePageSchema,
        create(github.PullRequestTimelinePageSchema, {
          items,
          page: scope.page(
            next,
            partial || (!!(request.author || request.kind) && !!more),
            partial
              ? "Some events are unavailable. Retry to load this page."
              : more && (request.author || request.kind)
                ? "More events may match. Continue to search older pages."
                : "",
          ),
        }),
      );
    },
  });
}
