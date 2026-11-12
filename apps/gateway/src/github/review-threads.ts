import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { graphPage } from "./timeline-query.ts";
import { graphErrors, jsonMessage, type ReadScope } from "./read-scope.ts";
import { actor, actorFields, actorLogin } from "./actors.ts";

const comment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  diffHunk: Schema.optional(Schema.String),
  url: Schema.String,
  createdAt: Schema.String,
  author: actor,
  originalCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
  viewerCanUpdate: Schema.optional(Schema.Boolean),
  viewerCanDelete: Schema.optional(Schema.Boolean),
  viewerDidAuthor: Schema.optional(Schema.Boolean),
  state: Schema.optional(Schema.String),
});

const thread = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  diffSide: Schema.optional(Schema.String),
  startLine: Schema.optional(Schema.NullOr(Schema.Number)),
  startDiffSide: Schema.optional(Schema.NullOr(Schema.String)),
  originalLine: Schema.optional(Schema.NullOr(Schema.Number)),
  originalStartLine: Schema.optional(Schema.NullOr(Schema.Number)),
  viewerCanResolve: Schema.optional(Schema.Boolean),
  viewerCanUnresolve: Schema.optional(Schema.Boolean),
  pullRequest: Schema.Struct({ id: Schema.String }),
  comments: Schema.Struct({ nodes: Schema.Array(comment), pageInfo: graphPage }),
});

const envelope = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      repository: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            pullRequest: Schema.NullOr(
              Schema.Struct({
                id: Schema.String,
                reviewThreads: Schema.NullOr(Schema.Struct({ nodes: Schema.Array(thread), pageInfo: graphPage })),
              }),
            ),
          }),
        ),
      ),
      node: Schema.optional(Schema.NullOr(thread)),
    }),
  ),
});

const fields = `id path line isResolved isOutdated diffSide startLine startDiffSide originalLine originalStartLine
viewerCanResolve viewerCanUnresolve pullRequest{id}
comments(first:50,after:$reply){pageInfo{hasNextPage endCursor} nodes{id body diffHunk url createdAt author{${actorFields}} originalCommit{oid} state viewerDidAuthor viewerCanUpdate viewerCanDelete}}`;

export const REVIEW_THREADS_QUERY = `query CanopyReviewThreads($owner:String!,$name:String!,$number:Int!,$after:String,$reply:String){
rateLimit{cost remaining resetAt} repository(owner:$owner,name:$name){pullRequest(number:$number){id
reviewThreads(first:30,after:$after){pageInfo{hasNextPage endCursor} nodes{${fields}}}}}}`;

export const REPLIES_QUERY = `query CanopyReviewReplies($id:ID!,$reply:String){rateLimit{cost remaining resetAt}
node(id:$id){... on PullRequestReviewThread{${fields}}}}`;

export async function reviewThreads(scope: ReadScope) {
  const replies = !!scope.request.resourceId;

  return scope.read(github.PullRequestReviewThreadsPageSchema, {
    path: "/graphql",
    query: replies ? REPLIES_QUERY : REVIEW_THREADS_QUERY,
    variables: replies
      ? { id: scope.request.resourceId, ...(scope.position && { reply: scope.position }) }
      : { ...scope.variables, ...(scope.position && { after: scope.position }) },
    project: async (value) => {
      const partial = graphErrors(value);
      const data = Schema.decodeUnknownSync(envelope)(value).data;
      const connection = data?.repository?.pullRequest?.reviewThreads;
      const nodes = replies && data?.node ? [data.node] : (connection?.nodes ?? []);

      if (
        nodes.some((n) => n.pullRequest.id !== scope.pr.node_id) ||
        (!replies && data?.repository?.pullRequest?.id !== scope.pr.node_id)
      )
        throw new ConnectError("Review thread not found", Code.NotFound);

      return jsonMessage(
        github.PullRequestReviewThreadsPageSchema,
        create(github.PullRequestReviewThreadsPageSchema, {
          threads: nodes.map((n) => ({
            id: n.id,
            path: n.path,
            line: n.line ?? n.originalLine ?? 0,
            resolved: n.isResolved,
            outdated: n.isOutdated,
            side: n.diffSide ?? "",
            startLine: n.startLine ?? n.originalStartLine ?? 0,
            startSide: n.startDiffSide ?? n.diffSide ?? "",
            originalLine: n.originalLine ?? 0,
            originalStartLine: n.originalStartLine ?? 0,
            viewerCanResolve: n.viewerCanResolve ?? false,
            viewerCanUnresolve: n.viewerCanUnresolve ?? false,
            sha: n.comments.nodes[0]?.originalCommit?.oid ?? "",
            comments: n.comments.nodes.map((c) => ({
              id: c.id,
              author: actorLogin(c.author),
              avatarUrl: c.author?.avatarUrl ?? "",
              body: c.body,
              diffHunk: (c.diffHunk ?? "").slice(0, 8_000),
              viewerCanUpdate: !!c.viewerDidAuthor && !!c.viewerCanUpdate,
              viewerCanDelete: !!c.viewerDidAuthor && !!c.viewerCanDelete,
              state: c.state ?? "",
              url: c.url,
              sha: c.originalCommit?.oid ?? "",
              createdAt: timestampFromDate(new Date(c.createdAt)),
            })),
            repliesCursor: n.comments.pageInfo.hasNextPage
              ? scope.replyCursor(n.id, n.comments.pageInfo.endCursor ?? "")
              : "",
          })),
          page: scope.page(
            connection?.pageInfo.hasNextPage ? (connection.pageInfo.endCursor ?? "") : "",
            partial || (!nodes.length && !!data?.node === false && !connection),
          ),
        }),
      );
    },
  });
}
