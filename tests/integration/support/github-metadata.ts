import { Schema } from "effect";
import { mutationFixture } from "./github-mutations.ts";
import { githubPrData } from "./github-pr.ts";

export function metadataFixture() {
  const users = [
    { node_id: "USER_AUTHOR", login: "pr-author", id: 101 },
    { node_id: "USER_REVIEWER", login: "reviewer", id: 102 },
    { node_id: "USER_MEMBER", login: "org-member", id: 103 },
  ];

  const teams = [{ node_id: "TEAM_REPO", slug: "platform", name: "Platform team" }];

  const labels = ["d73a4a", "a2eeef", "7057ff", "0e8a16", "fbca04", "ffffff", "000000"].map((color, i) => ({
    node_id: `LABEL_${i}`,
    name: `label-${i}`,
    color,
  }));

  const state = {
    title: "Improve metadata editing",
    body: "# Summary\n\nA **fixture** description.",
    reviewers: ["USER_REVIEWER"],
    assignees: ["USER_REVIEWER"],
    labels: ["LABEL_0"],
    members: true,
    issues: true,
    writes: 0,
    lost: false,
    race: false,
    denyAfterWrite: false,
    verificationDenied: false,
    before: () => {},
  };

  const pageInfo = { hasNextPage: false, endCursor: null };
  const person = (id: string) => users.find((u) => u.node_id === id)!;

  const reviewers = () =>
    state.reviewers.map((id) => ({
      requestedReviewer: id.startsWith("TEAM")
        ? { id, slug: "platform", organization: { login: "itsoltech" } }
        : { id, login: person(id).login },
    }));

  const pull = () => ({
    ...githubPrData(),
    title: state.title,
    body: state.body,
    viewerCanUpdate: true,
    author: { id: "USER_AUTHOR", login: "pr-author" },
    reviewRequests: { nodes: reviewers(), pageInfo },
    assignees: { nodes: state.assignees.map((id) => ({ id, login: person(id).login })), pageInfo },
    labels: {
      nodes: state.labels.map((id) => {
        const l = labels.find((v) => v.node_id === id)!;

        return { id, name: l.name, color: l.color };
      }),
      pageInfo,
    },
  });

  const fixture = mutationFixture({
    graph: (query, variables) => {
      if (query.includes("CanopyMetadata(") && state.verificationDenied) return Response.json({}, { status: 403 });

      if (query.includes("CanopyMetadataTargets")) {
        const { ids } = Schema.decodeUnknownSync(Schema.Struct({ ids: Schema.Array(Schema.String) }))(variables);

        return Response.json({
          data: {
            nodes: ids.map((id) => {
              const user = users.find((v) => v.node_id === id),
                label = labels.find((v) => v.node_id === id);

              if (user) return { id, __typename: "User", login: user.login };

              if (label) return { id, __typename: "Label", name: label.name, repository: { databaseId: 777 } };

              if (id === "LABEL_FOREIGN")
                return { id, __typename: "Label", name: "foreign", repository: { databaseId: 888 } };

              if (id.startsWith("TEAM"))
                return {
                  id,
                  __typename: "Team",
                  slug: "platform",
                  organization: { login: id === "TEAM_OTHER_ORG" ? "other" : "itsoltech" },
                  repositories: { nodes: [{ databaseId: id === "TEAM_REPO" ? 777 : 888 }] },
                };

              return null;
            }),
          },
        });
      }

      if (query.includes("CanopyMetadata") || query.includes("CanopyPullRequest"))
        return Response.json({
          data: { repository: { databaseId: 777, viewerPermission: "WRITE", pullRequest: pull() } },
        });

      return undefined;
    },
    rest: (request) => {
      const path = new URL(request.url).pathname;

      if (path === "/user/installations")
        return Response.json({
          total_count: 1,
          installations: [
            {
              id: 101,
              account: { login: "itsoltech", type: "Organization" },
              repository_selection: "selected",
              permissions: {
                pull_requests: "write",
                ...(state.issues && { issues: "write" }),
                ...(state.members && { members: "read" }),
              },
              suspended_at: null,
            },
          ],
        });

      if (request.method === "GET") {
        if (path.endsWith("/collaborators") || path.endsWith("/assignees")) return Response.json(users.slice(0, 2));

        if (path.endsWith("/members"))
          return state.members ? Response.json(users.slice(2)) : Response.json({}, { status: 403 });

        if (path.endsWith("/teams")) return state.members ? Response.json(teams) : Response.json({}, { status: 403 });

        if (path.endsWith("/labels")) return Response.json(labels);

        if (/\/(collaborators|assignees|members)\//.test(path))
          return new Response(null, { status: users.some((u) => path.endsWith(`/${u.login}`)) ? 204 : 404 });

        return undefined;
      }

      if (!/^\/repos\/itsoltech\/canopy\/(pulls\/42|issues\/42)(\/requested_reviewers|\/labels)?$/.test(path))
        return undefined;

      return request.json().then((json) => {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            title: Schema.optional(Schema.String),
            body: Schema.optional(Schema.String),
            reviewers: Schema.optional(Schema.Array(Schema.String)),
            team_reviewers: Schema.optional(Schema.Array(Schema.String)),
            assignees: Schema.optional(Schema.Array(Schema.String)),
            labels: Schema.optional(Schema.Array(Schema.String)),
          }),
        )(json);

        state.writes++;
        state.verificationDenied = state.denyAfterWrite;
        state.before();

        if (body.title !== undefined) state.title = body.title;

        if (body.body !== undefined) state.body = body.body;

        if (body.assignees)
          state.assignees = body.assignees.map((name) => users.find((u) => u.login === name)!.node_id);

        if (body.labels) state.labels = body.labels.map((name) => labels.find((l) => l.name === name)!.node_id);

        if (body.reviewers) {
          const ids = [
            ...body.reviewers.map((name) => users.find((u) => u.login === name)!.node_id),
            ...(body.team_reviewers ?? []).map(() => "TEAM_REPO"),
          ];

          state.reviewers =
            request.method === "DELETE"
              ? state.reviewers.filter((id) => !ids.includes(id))
              : [...new Set([...state.reviewers, ...ids])];
        }

        if (state.race) state.title = "Changed by another editor during saving";

        if (state.lost) {
          state.lost = false;

          return Response.json({}, { status: 502 });
        }

        return Response.json({ id: 42, node_id: "PR_fixture_42" });
      });
    },
  });

  return { ...fixture, state, users, teams, labels };
}
