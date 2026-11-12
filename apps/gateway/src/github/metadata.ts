import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import type { ReadScope } from "./read-scope.ts";
import type { GitHubPullRequests } from "./pull-requests.ts";
import { GitHubHttpFailure } from "./http.ts";
import { METADATA_QUERY, metadataData, metadataView } from "./metadata-state.ts";

/** Fetch every current assignment before presenting a replace-set edit. */
export async function currentMetadata(
  prs: GitHubPullRequests,
  account: string,
  repo: { repository_name: string; repository_id: string; number: number; node_id: string },
  read?: (query: string, variables: Record<string, string | number>) => Promise<Schema.JsonObject>,
) {
  let reviewers = "",
    assignees = "",
    labels = "";

  let reviewersDone = false,
    assigneesDone = false,
    labelsDone = false;

  let aggregate: ReturnType<typeof metadataData> | undefined;

  type PullRequest = NonNullable<ReturnType<typeof metadataData>["pullRequest"]>;

  const requested: Array<PullRequest["reviewRequests"]["nodes"][number]> = [];
  const assigned: Array<PullRequest["assignees"]["nodes"][number]> = [];
  const labelled: Array<PullRequest["labels"]["nodes"][number]> = [];

  for (let page = 0; page < 100; page++) {
    const variables = {
      owner: repo.repository_name.split("/")[0]!,
      name: repo.repository_name.split("/")[1]!,
      number: repo.number,
      ...(reviewers && { reviewers }),
      ...(assignees && { assignees }),
      ...(labels && { labels }),
    };

    const value = read
      ? { payload: await read(METADATA_QUERY, variables) }
      : await prs.client.read(
          account,
          {
            key: `metadata:${repo.repository_id}:${repo.number}:${page}`,
            path: "/graphql",
            query: METADATA_QUERY,
            variables,
          },
          true,
        );

    if (!value.payload) throw new ConnectError("Could not load these fields. Refresh to retry.", Code.Unavailable);
    const data = metadataData(value.payload, repo.repository_id, repo.node_id);
    const pr = data.pullRequest!; // SAFETY: metadataData checked this identity.

    if (aggregate) {
      const previous = aggregate.pullRequest!; // SAFETY: every aggregate came from metadataData.

      if (previous.title !== pr.title || previous.body !== pr.body)
        throw new ConnectError("Pull request changed. Refresh to retry.", Code.FailedPrecondition);
    } else aggregate = data;

    if (!reviewersDone) requested.push(...pr.reviewRequests.nodes);

    if (!assigneesDone) assigned.push(...pr.assignees.nodes);

    if (!labelsDone) labelled.push(...pr.labels.nodes);
    reviewersDone ||= !pr.reviewRequests.pageInfo.hasNextPage;
    assigneesDone ||= !pr.assignees.pageInfo.hasNextPage;
    labelsDone ||= !pr.labels.pageInfo.hasNextPage;
    reviewers = !reviewersDone ? (pr.reviewRequests.pageInfo.endCursor ?? "") : "";
    assignees = !assigneesDone ? (pr.assignees.pageInfo.endCursor ?? "") : "";
    labels = !labelsDone ? (pr.labels.pageInfo.endCursor ?? "") : "";

    if (!reviewers && !assignees && !labels) {
      const first = aggregate.pullRequest!; // SAFETY: metadataData checked this identity.

      const result = {
        ...aggregate,
        pullRequest: {
          ...first,
          reviewRequests: { ...first.reviewRequests, nodes: requested },
          assignees: { ...first.assignees, nodes: assigned },
          labels: { ...first.labels, nodes: labelled },
        },
      };

      return { data: result, view: metadataView(result) };
    }
  }

  throw new ConnectError("Too many assignments to edit here. Open on GitHub.", Code.ResourceExhausted);
}

const Item = Schema.Struct({
  node_id: Schema.String,
  id: Schema.optional(Schema.Number),
  login: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
  avatar_url: Schema.optional(Schema.String),
});

export async function metadataPage(scope: ReadScope) {
  const mapping = await scope.prs.repositories.selected(scope.pr.repository_name);
  const kind = scope.request.kind || "details";

  if (!["details", "reviewers", "assignees", "labels"].includes(kind) || scope.request.author.length > 100)
    throw new ConnectError("Choose a supported field.", Code.InvalidArgument);
  const current = await currentMetadata(scope.prs, scope.row.id, scope.pr);
  const index = Number(scope.position || "1");

  if (!Number.isInteger(index) || index < 1 || index > 200)
    throw new ConnectError("Refresh this picker.", Code.InvalidArgument);
  let membersAvailable = true;
  let more = false;
  const options: github.PullRequestMetadataOption[] = [];
  const collaborators = new Set<string>();

  const paths = metadataPaths(kind, scope.root);

  if (kind === "reviewers")
    paths.push(`/orgs/${scope.variables.owner}/members`, `/orgs/${scope.variables.owner}/teams`);

  for (const path of paths) {
    try {
      const result = await scope.prs.client.read(
        scope.row.id,
        {
          key: `metadata-options:${path}:${index}`,
          path: `${path}?per_page=100&page=${index}`,
        },
        scope.request.refresh,
      );

      const items = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Item) }))(result.payload).items;
      more ||= items.length === 100;

      for (const item of items) {
        if (!path.startsWith("/orgs/")) collaborators.add(item.node_id);
        const name = item.login ?? (item.slug ? `${scope.variables.owner}/${item.slug}` : (item.name ?? ""));

        if (
          (kind === "reviewers" &&
            (item.node_id === current.data.pullRequest?.author?.id ||
              item.login === current.data.pullRequest?.author?.login)) ||
          !name.toLowerCase().includes(scope.request.author.toLowerCase())
        )
          continue;

        if (!options.some((o) => o.id === item.node_id))
          options.push(
            create(github.PullRequestMetadataOptionSchema, {
              id: item.node_id,
              name,
              kind: item.slug ? "team" : item.login ? "user" : "label",
              color: item.color && /^[a-f0-9]{6}$/i.test(item.color) ? item.color : "",
              userId: item.login && item.id ? String(item.id) : "",
              avatarUrl: item.avatar_url ?? "",
            }),
          );
      }
    } catch (cause) {
      if (!(cause instanceof GitHubHttpFailure) || ![403, 404].includes(cause.status) || cause.retryAt) throw cause;

      if (!path.startsWith("/orgs/")) throw cause;
      membersAvailable = false;
    }
  }

  const selected = await scope.prs.repositories.selected(scope.pr.repository_name);

  if (
    selected.row.id !== scope.row.id ||
    selected.row.revision !== scope.row.revision ||
    selected.mapping.revision !== mapping.mapping.revision
  )
    throw new ConnectError("Repository account changed. Refresh before editing.", Code.FailedPrecondition);

  return create(github.PullRequestMetadataPageSchema, {
    metadata: current.view,
    options: membersAvailable ? options : options.filter((o) => collaborators.has(o.id)),
    membersAvailable,
    page: scope.page(
      more ? String(index + 1) : "",
      more,
      !membersAvailable ? "Organization members and teams are unavailable. Choose a repository collaborator." : "",
    ),
  });
}

function metadataPaths(kind: string, root: string) {
  if (kind === "details") return [];

  if (kind === "labels") return [`${root}/labels`];

  return [`${root}/${kind === "assignees" ? "assignees" : "collaborators"}`];
}
