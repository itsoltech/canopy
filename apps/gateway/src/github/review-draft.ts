import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { changesUpdated, digest, graphErrors, jsonMessage, type ReadScope } from "./read-scope.ts";

const actor = Schema.NullOr(Schema.Struct({ databaseId: Schema.NullOr(Schema.Number) }));

const review = Schema.Struct({
  id: Schema.String,
  fullDatabaseId: Schema.String,
  body: Schema.String,
  updatedAt: Schema.String,
  author: actor,
  commit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
  comments: Schema.Struct({ totalCount: Schema.Number }),
});

const header = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        databaseId: Schema.Number,
        pullRequest: Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            headRefOid: Schema.String,
            author: actor,
            reviews: Schema.Struct({ nodes: Schema.Array(review) }),
          }),
        ),
      }),
    ),
  }),
});

export const REVIEW_DRAFT_QUERY = `query CanopyReviewDraft($owner:String!,$name:String!,$number:Int!,$login:String!){
rateLimit{cost remaining resetAt} repository(owner:$owner,name:$name){databaseId
pullRequest(number:$number){id headRefOid author{... on User{databaseId}}
reviews(first:1,author:$login,states:[PENDING]){nodes{id fullDatabaseId body updatedAt
author{... on User{databaseId}} commit{oid} comments{totalCount}}}}}}`;

export function draftHeader(value: Schema.JsonObject, pr: { node_id: string; repository_id: string }, user: string) {
  if (graphErrors(value))
    throw new ConnectError("Could not load the pending review. Refresh, then retry.", Code.Unavailable);
  const repo = Schema.decodeUnknownSync(header)(value).data.repository;
  const pull = repo?.pullRequest;

  if (!pull || String(repo?.databaseId) !== pr.repository_id || pull.id !== pr.node_id)
    throw new ConnectError("Pull request not found", Code.NotFound);
  const pending = pull.reviews.nodes[0];

  if (pending && (String(pending.author?.databaseId) !== user || !/^[1-9]\d*$/.test(pending.fullDatabaseId)))
    throw new ConnectError("Pending review not found", Code.NotFound);

  return { head: pull.headRefOid, viewerIsAuthor: String(pull.author?.databaseId) === user, pending };
}

export type DraftHeader = ReturnType<typeof draftHeader>;

const comment = Schema.Struct({
  node_id: Schema.String,
  body: Schema.String,
  path: Schema.String,
  side: Schema.String,
  start_side: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Number),
  start_line: Schema.NullOr(Schema.Number),
  original_line: Schema.Number,
  original_start_line: Schema.NullOr(Schema.Number),
  original_commit_id: Schema.String,
  updated_at: Schema.String,
  created_at: Schema.String,
  html_url: Schema.String,
  user: Schema.Struct({ id: Schema.Number, login: Schema.String }),
});

export function draftPage(value: Schema.JsonObject, h: DraftHeader, user: string, page: github.PullRequestPageInfo) {
  const comments = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(comment) }))(value).items;

  if (comments.some((c) => String(c.user.id) !== user))
    throw new ConnectError("Pending review not found", Code.NotFound);
  const pending = h.pending;

  return create(github.PullRequestReviewDraftSchema, {
    id: pending?.id ?? "",
    sha: pending?.commit?.oid ?? "",
    body: pending?.body ?? "",
    totalCount: pending?.comments.totalCount ?? 0,
    viewerIsAuthor: h.viewerIsAuthor,
    page,
    revision: digest(JSON.stringify([h, comments])),
    comments: comments.map((c) => ({
      path: c.path,
      side: c.side,
      line: c.line ?? c.original_line,
      startSide: c.start_side ?? c.side,
      startLine: c.start_line ?? c.original_start_line ?? 0,
      outdated: c.line === null || c.original_commit_id !== h.head,
      comment: {
        id: c.node_id,
        body: c.body,
        author: c.user.login,
        sha: c.original_commit_id,
        url: c.html_url,
        createdAt: timestampFromDate(new Date(c.created_at)),
        viewerCanUpdate: true,
        viewerCanDelete: true,
      },
    })),
  });
}

export const draftPath = (root: string, number: number, id: string, page: number) =>
  `${root}/pulls/${number}/reviews/${id}/comments?per_page=50&page=${page}`;

export async function reviewDraft(scope: ReadScope) {
  const result = await scope.prs.client.read(
    scope.row.id,
    {
      key: `pending-header:${scope.pr.id}`,
      path: "/graphql",
      query: REVIEW_DRAFT_QUERY,
      variables: { ...scope.variables, login: scope.row.login },
    },
    scope.request.refresh,
  );

  if (!result.payload)
    throw new ConnectError("Could not load the pending review. Refresh, then retry.", Code.Unavailable);
  const h = draftHeader(result.payload, scope.pr, scope.row.github_user_id);

  if (h.head !== scope.head) throw changesUpdated();
  const [reviewId, number] = scope.position ? scope.position.split(":") : [h.pending?.id ?? "", "1"];
  const page = Number(number);

  if (reviewId !== (h.pending?.id ?? "") || !Number.isInteger(page) || page < 1 || page > 200)
    throw new ConnectError("Pending review changed. Refresh before submitting.", Code.FailedPrecondition);

  if (!h.pending) return draftPage({ items: [] }, h, scope.row.github_user_id, scope.page());

  return scope.read(github.PullRequestReviewDraftSchema, {
    path: draftPath(scope.root, scope.pr.number, h.pending.fullDatabaseId, page),
    project: async (value, headers) => {
      const more = (headers.get("link") ?? "").includes('rel="next"');
      const info = scope.page(more ? `${reviewId}:${page + 1}` : "");

      return jsonMessage(github.PullRequestReviewDraftSchema, draftPage(value, h, scope.row.github_user_id, info));
    },
  });
}
