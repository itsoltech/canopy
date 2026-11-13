import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { githubImageUrl, resolvedGitHubImage } from "@canopy/domain/github-images";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { digest, readScope } from "./read-scope.ts";
import type { GitHubPullRequests } from "./pull-requests.ts";

const query = `query CanopyImageContent($id:ID!){rateLimit{cost remaining resetAt} node(id:$id){
... on PullRequest{id bodyHTML}
... on IssueComment{bodyHTML pullRequest{id}}
... on PullRequestReview{bodyHTML pullRequest{id}}
... on PullRequestReviewComment{bodyHTML pullRequest{id}}
}}`;

const parent = Schema.Struct({ id: Schema.String });

const envelope = Schema.Struct({
  data: Schema.Struct({
    node: Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        bodyHTML: Schema.String,
        pullRequest: Schema.optional(parent),
      }),
    ),
  }),
});

const image = Schema.Struct({ dataUrl: Schema.String });

/** Authorize the PR, selected account and containing GitHub node before serving any cached bytes. */
export async function pullRequestImage(prs: GitHubPullRequests, request: github.PullRequestImageRequest) {
  const scope = await readScope(
    prs,
    create(github.PullRequestPageRequestSchema, { pullRequestId: request.pullRequestId }),
    "image",
  );

  const source = githubImageUrl(request.url);

  if (!source || !request.contentId || request.contentId.length > 256)
    throw new ConnectError("Image unavailable. Open it on GitHub.", Code.InvalidArgument);

  const content = await prs.client.read(scope.row.id, {
    key: `image-content:${scope.binding}:${digest(request.contentId)}`,
    path: "/graphql",
    query,
    variables: { id: request.contentId },
    ttl: 60_000,
    project: async (value) => {
      const node = Schema.decodeUnknownSync(envelope)(value).data.node;

      if (!node || (node.pullRequest?.id ?? node.id) !== scope.pr.node_id)
        throw new ConnectError("Image not found", Code.NotFound);

      return { html: node.bodyHTML };
    },
  });

  const html = Schema.decodeUnknownSync(Schema.Struct({ html: Schema.String }))(content.payload).html;
  const resolved = resolvedGitHubImage(html, source);

  if (!resolved) throw new ConnectError("Image not found", Code.NotFound);

  const value = await prs.client.read(scope.row.id, {
    key: `image:${scope.binding}:${digest(`${request.contentId}:${source}`)}`,
    path: resolved,
    attachment: true,
    ttl: 300_000,
  });

  // Recheck mapping/account revisions after I/O, including a cache hit.
  const current = await readScope(prs, scope.request, "image");

  if (current.binding !== scope.binding)
    throw new ConnectError("Repository access changed. Refresh.", Code.FailedPrecondition);

  return create(github.PullRequestImageSchema, Schema.decodeUnknownSync(image)(value.payload));
}
