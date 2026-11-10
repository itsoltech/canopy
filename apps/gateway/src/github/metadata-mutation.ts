import type { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import type { MutationScope } from "./mutation-preflight.ts";
import { mutationBudget } from "./mutation-http.ts";
import { graphErrors } from "./read-scope.ts";
import { currentMetadata } from "./metadata.ts";
import { GitHubHttpFailure } from "./http.ts";

export const metadataActions = ["update_details", "request_reviewers", "set_assignees", "set_labels"];

export const metadataParameters = (r: github.PullRequestMutationRequest) => ({
  metadataRevision: r.metadataRevision,
  metadataIds: r.metadataIds,
  reviewerAction: r.reviewerAction,
});

export function validateMetadata(r: github.PullRequestMutationRequest) {
  if (!metadataActions.includes(r.action)) return;

  if (
    !/^[a-f0-9]{64}$/.test(r.metadataRevision) ||
    r.metadataIds.length > 100 ||
    new Set(r.metadataIds).size !== r.metadataIds.length ||
    r.metadataIds.some((id) => !/^[A-Za-z0-9_=-]{1,256}$/.test(id))
  )
    throw new ConnectError("Refresh these fields before applying changes.", Code.InvalidArgument);

  if (
    r.action === "update_details" &&
    (!r.title.trim() ||
      r.title.length > 256 ||
      /[\r\n\0]/.test(r.title) ||
      Buffer.byteLength(r.body) > 65536 ||
      r.body.includes(String.fromCharCode(0)))
  )
    throw new ConnectError("Use a title up to 256 characters and a description up to 64 KiB.", Code.InvalidArgument);

  if (
    r.action === "request_reviewers" &&
    (!["request", "re_request", "remove"].includes(r.reviewerAction) ||
      !r.metadataIds.length ||
      r.metadataIds.length > 15)
  )
    throw new ConnectError("Choose reviewers and a review action.", Code.InvalidArgument);

  if (r.action === "set_assignees" && r.metadataIds.length > 10)
    throw new ConnectError("Choose up to 10 assignees.", Code.InvalidArgument);
}

async function raw(scope: MutationScope, path: string, body?: Schema.JsonObject) {
  const response = await scope.prs.accounts.http.detailed(
    path,
    {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${scope.access.token}`, "Content-Type": "application/json" },
      ...(body && { body: JSON.stringify(body) }),
    },
    [scope.access.token, ...(scope.access.secrets ?? [])],
  );

  await mutationBudget(scope, response.value, response.headers);

  if (!response.value) throw new ConnectError("Could not verify these fields. Refresh to retry.", Code.Unavailable);

  return response.value;
}

export const freshMetadata = (scope: MutationScope) =>
  currentMetadata(scope.prs, scope.access.row.id, scope.pr, (query, variables) =>
    raw(scope, "/graphql", { query, variables }),
  );

const Node = Schema.Struct({
  id: Schema.String,
  __typename: Schema.String,
  login: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.Struct({ databaseId: Schema.Number })),
  organization: Schema.optional(Schema.Struct({ login: Schema.String })),
  repositories: Schema.optional(Schema.Struct({ nodes: Schema.Array(Schema.Struct({ databaseId: Schema.Number })) })),
});

export async function metadataPreflight(
  scope: MutationScope,
  r: github.PullRequestMutationRequest,
  renew: () => Promise<void>,
) {
  const current = await freshMetadata(scope);

  const field = metadataField(r.action);

  if (!current.view.actions.includes(field))
    throw new ConnectError("GitHub does not allow this edit. Check repository access.", Code.PermissionDenied);

  if (current.view.revision !== r.metadataRevision)
    throw new ConnectError(
      "These fields changed on GitHub. Compare changes, then refresh before applying.",
      Code.Aborted,
    );

  if (!r.metadataIds.length) return [];

  const value = await raw(scope, "/graphql", {
    query: `query CanopyMetadataTargets($ids:[ID!]!,$name:String!){rateLimit{cost remaining resetAt} nodes(ids:$ids){id __typename ... on User{login} ... on Label{name repository{databaseId}} ... on Team{slug organization{login} repositories(first:100,query:$name){nodes{databaseId}}}}}`,
    variables: { ids: r.metadataIds, name: scope.pr.repository_name.split("/")[1]! },
  });

  if (graphErrors(value))
    throw new ConnectError("Could not verify selections. Refresh this picker.", Code.FailedPrecondition);

  const nodes = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(Node)) }) }),
  )(value).data.nodes;

  const selected: Array<{ id: string; name: string; kind: string }> = [];

  for (const id of r.metadataIds) {
    await renew();
    const n = nodes.find((node) => node?.id === id);

    if (!n) throw new ConnectError("Selection not found", Code.NotFound);

    if (field === "labels") {
      if (n.__typename !== "Label" || String(n.repository?.databaseId) !== scope.pr.repository_id || !n.name)
        throw new ConnectError("Label not found", Code.NotFound);
      selected.push({ id, name: n.name, kind: "label" });
    } else if (n.__typename === "Team" && field === "reviewers") {
      if (
        n.organization?.login.toLowerCase() !== scope.pr.repository_name.split("/")[0]!.toLowerCase() ||
        !n.repositories?.nodes.some((repo) => String(repo.databaseId) === scope.pr.repository_id) ||
        !n.slug ||
        !/^[A-Za-z0-9-]{1,100}$/.test(n.slug)
      )
        throw new ConnectError("Team not found in this repository", Code.NotFound);
      selected.push({ id, name: n.slug, kind: "team" });
    } else {
      if (
        n.__typename !== "User" ||
        !n.login ||
        !/^[A-Za-z0-9-]{1,100}$/.test(n.login) ||
        (field === "reviewers" &&
          (id === current.data.pullRequest?.author?.id || n.login === current.data.pullRequest?.author?.login))
      )
        throw new ConnectError("User not found", Code.NotFound);
      const suffix = field === "assignees" ? "assignees" : "collaborators";

      try {
        await raw(scope, `/repos/${scope.pr.repository_name}/${suffix}/${n.login}`);
      } catch (cause) {
        if (
          !(cause instanceof GitHubHttpFailure) ||
          ![403, 404].includes(cause.status) ||
          cause.retryAt ||
          field !== "reviewers"
        )
          throw cause;
        await raw(scope, `/orgs/${scope.pr.repository_name.split("/")[0]}/members/${n.login}`);
      }

      selected.push({ id, name: n.login, kind: "user" });
    }
  }

  return selected;
}

export function metadataMutation(
  scope: MutationScope,
  r: github.PullRequestMutationRequest,
  selected: Array<{ name: string; kind: string }>,
) {
  const root = `/repos/${scope.pr.repository_name}`;

  if (r.action === "update_details")
    return { path: `${root}/pulls/${scope.pr.number}`, method: "PATCH", body: { title: r.title, body: r.body } };

  if (r.action === "request_reviewers")
    return {
      path: `${root}/pulls/${scope.pr.number}/requested_reviewers`,
      method: r.reviewerAction === "remove" ? "DELETE" : "POST",
      body: {
        reviewers: selected.flatMap((n) => (n.kind === "user" ? [n.name] : [])),
        team_reviewers: selected.flatMap((n) => (n.kind === "team" ? [n.name] : [])),
      },
    };

  return {
    path: `${root}/issues/${scope.pr.number}${r.action === "set_labels" ? "/labels" : ""}`,
    method: r.action === "set_labels" ? "PUT" : "PATCH",
    body: { [r.action === "set_labels" ? "labels" : "assignees"]: selected.map((n) => n.name) },
  };
}

export function metadataMatches(view: github.PullRequestMetadata, r: github.PullRequestMutationRequest) {
  if (r.action === "update_details") return view.title === r.title && view.body === r.body;

  const ids = metadataValues(view, r.action).map((v) => v.id);

  if (r.action === "request_reviewers")
    return r.metadataIds.every((id) => ids.includes(id) === (r.reviewerAction !== "remove"));

  return ids.length === r.metadataIds.length && r.metadataIds.every((id) => ids.includes(id));
}

function metadataField(action: string) {
  if (action === "update_details") return "details";

  if (action === "request_reviewers") return "reviewers";

  if (action === "set_assignees") return "assignees";

  return "labels";
}

function metadataValues(view: github.PullRequestMetadata, action: string) {
  if (action === "set_labels") return view.labels;

  if (action === "set_assignees") return view.assignees;

  return view.reviewers;
}
