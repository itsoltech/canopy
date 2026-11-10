import { Schema } from "effect";
import { readFixture, readHead, readBase } from "./github-read.ts";
import { githubPrData } from "./github-pr.ts";

const Input = Schema.Struct({
  pullRequestId: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  expectedHeadOid: Schema.optional(Schema.String),
  headRefName: Schema.optional(Schema.String),
  baseRefName: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  draft: Schema.optional(Schema.Boolean),
  maintainerCanModify: Schema.optional(Schema.Boolean),
  mergeMethod: Schema.optional(Schema.String),
  updateMethod: Schema.optional(Schema.String),
  commitHeadline: Schema.optional(Schema.String),
  commitBody: Schema.optional(Schema.String),
});

export function lifecycleFixture() {
  const state = {
    head: readHead,
    base: readBase,
    branch: "feature",
    state: "OPEN",
    draft: false,
    queue: false,
    enqueued: false,
    auto: "",
    mergeable: "MERGEABLE",
    mergeStatus: "CLEAN",
    review: "APPROVED",
    checks: "SUCCESS",
    methods: ["MERGE", "SQUASH", "REBASE"],
    headWrite: true,
    maintainer: true,
    author: false,
    permission: "WRITE",
    published: true,
    fork: false,
    rejected: false,
    existing: false,
    existingHead: "",
    lost: false,
    writes: 0,
    creates: 0,
    update: "",
    mergeTitle: "",
    mergeBody: "",
    before: () => {},
  };

  const created = new Map<number, { title: string; body: string; draft: boolean }>();

  const repo = () => ({
    databaseId: 777,
    viewerPermission: state.permission,
    mergeCommitAllowed: state.methods.includes("MERGE"),
    squashMergeAllowed: state.methods.includes("SQUASH"),
    rebaseMergeAllowed: state.methods.includes("REBASE"),
    autoMergeAllowed: true,
  });

  const pull = (number = 42) => ({
    ...githubPrData(number, state.state, number >= 100 ? (created.get(number)?.draft ?? state.draft) : state.draft),
    ...(created.has(number) && { title: created.get(number)!.title, body: created.get(number)!.body }),
    headRefOid: state.head,
    baseRefOid: state.base,
    headRefName: state.branch,
    headRepository: {
      databaseId: state.fork ? 888 : 777,
      nameWithOwner: state.fork ? "fork-owner/canopy" : "itsoltech/canopy",
    },
    mergeable: state.mergeable,
    mergeStateStatus: state.mergeStatus,
    reviewDecision: state.review,
    isMergeQueueEnabled: state.queue,
    isInMergeQueue: state.enqueued,
    maintainerCanModify: state.maintainer,
    viewerDidAuthor: state.author,
    viewerCanUpdate: true,
    viewerCanClose: true,
    viewerCanReopen: true,
    viewerCanUpdateBranch: true,
    viewerCanEnableAutoMerge: !state.auto,
    viewerCanDisableAutoMerge: !!state.auto,
    viewerMergeHeadlineText: "feat: lifecycle fixture",
    viewerMergeBodyText: "A safe change from the fixture.",
    autoMergeRequest: state.auto ? { mergeMethod: state.auto, enabledBy: { login: "account-101" } } : null,
    headRef: {
      repository: { databaseId: state.fork ? 888 : 777, viewerPermission: state.headWrite ? "WRITE" : "READ" },
    },
    commits: {
      nodes: [
        {
          commit: {
            oid: state.head,
            statusCheckRollup: {
              state: state.checks,
              contexts: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
            },
          },
        },
      ],
    },
  });

  const response = (value: Schema.JsonObject) =>
    Response.json({ data: { ...value, rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-11-12T00:00:00Z" } } });

  const fixture = readFixture(
    async (query, variables) => {
      const v = Schema.decodeUnknownSync(
        Schema.Struct({ number: Schema.optional(Schema.Number), input: Schema.optional(Input) }),
      )(variables);

      if (
        query.includes("CanopyPullRequest") ||
        query.includes("CanopyLifecyclePreflight") ||
        query.includes("CanopyMutationPreflight")
      )
        return response({ repository: { ...repo(), pullRequest: pull(v.number) }, node: null });

      if (!query.startsWith("mutation ")) return;
      state.writes++;
      state.before();
      const i = v.input;

      if (!i) throw new Error("Fixture requires mutation input");

      if (state.rejected || (i.expectedHeadOid && i.expectedHeadOid !== state.head))
        return Response.json({ data: { result: null }, errors: [{ type: "FORBIDDEN" }] });

      if (query.includes("CanopyCreatePullRequest")) {
        state.creates++;
        const number = 99 + state.creates;
        created.set(number, { title: i.title ?? "", body: i.body ?? "", draft: !!i.draft });

        return response({
          result: {
            pullRequest: {
              id: `PR_fixture_${number}`,
              number,
              repository: { databaseId: 777, nameWithOwner: "itsoltech/canopy" },
            },
          },
        });
      }

      if (query.includes("convertPullRequestToDraft")) state.draft = true;

      if (query.includes("markPullRequestReadyForReview")) state.draft = false;

      if (query.includes("closePullRequest")) state.state = "CLOSED";

      if (query.includes("reopenPullRequest")) state.state = "OPEN";

      if (query.includes("enablePullRequestAutoMerge")) state.auto = i.mergeMethod ?? "MERGE";

      if (query.includes("disablePullRequestAutoMerge")) state.auto = "";

      if (query.includes("updatePullRequestBranch")) state.update = i.updateMethod ?? "MERGE";

      if (query.includes("enqueuePullRequest")) {
        state.enqueued = true;

        return response({ result: { mergeQueueEntry: { id: "QUEUE_42" } } });
      }

      if (query.includes("dequeuePullRequest")) state.enqueued = false;

      return response({ result: { pullRequest: { id: "PR_fixture_42" } } });
    },
    (request) => {
      const url = new URL(request.url),
        path = url.pathname;

      if (path === "/user/installations")
        return Response.json({
          total_count: 1,
          installations: [
            {
              id: 101,
              account: { login: "fixture", type: "Organization" },
              repository_selection: "selected",
              permissions: { contents: "write", pull_requests: "write", merge_queues: "write" },
              suspended_at: null,
            },
          ],
        });

      if (/\/installations\/\d+\/repositories$/.test(path))
        return Response.json({
          total_count: 2,
          repositories: [
            { id: 777, full_name: "itsoltech/canopy", private: true, permissions: { pull: true, push: true } },
            { id: 888, full_name: "fork-owner/canopy", private: true, permissions: { pull: true, push: true } },
          ],
        });

      if (["/repos/itsoltech/canopy", "/repos/fork-owner/canopy"].includes(path))
        return Response.json({
          id: path.includes("fork-owner") ? 888 : 777,
          node_id: path.includes("fork-owner") ? "REPO_FORK" : "REPO_BASE",
          full_name: path.slice(7),
          private: true,
          default_branch: "dev",
          permissions: { pull: true, push: true },
          ...(path.includes("fork-owner") && { parent: { full_name: "itsoltech/canopy" } }),
        });

      if (path.endsWith("/branches"))
        return Response.json(
          ["dev", state.branch, "release/a-very-long-base-branch-name-for-testing-truncation"].map((name) => ({
            name,
            commit: { sha: name === state.branch ? state.head : state.base },
          })),
        );

      if (path.endsWith("/pulls"))
        return Response.json(
          state.existing
            ? [
                {
                  number: 42,
                  state: "open",
                  merged_at: null,
                  head: {
                    ref: state.branch,
                    sha: state.existingHead || state.head,
                    repo: { id: 777, full_name: "itsoltech/canopy" },
                  },
                  base: { ref: "dev", repo: { id: 777, full_name: "itsoltech/canopy" } },
                },
              ]
            : [],
        );

      if (path.includes("/branches/")) {
        const name = decodeURIComponent(path.split("/branches/")[1]!);

        return state.published || name !== state.branch
          ? Response.json({ name, commit: { sha: name === state.branch ? state.head : state.base } })
          : Response.json({}, { status: 404 });
      }

      if (path.includes("/compare/"))
        return Response.json({
          total_commits: 1,
          commits: [{ sha: state.head, commit: { message: "feat: improve branch lifecycle" } }],
          files: [{ filename: "src/safe.ts", patch: "@@ -1 +1 @@\n-old\n+new" }],
        });

      if (path.endsWith("/pulls/42/merge"))
        return request.json().then((json) => {
          const input = Schema.decodeUnknownSync(
            Schema.Struct({
              sha: Schema.String,
              merge_method: Schema.String,
              commit_title: Schema.optional(Schema.String),
              commit_message: Schema.optional(Schema.String),
            }),
          )(json);

          state.writes++;
          state.before();

          if (
            state.rejected ||
            state.queue ||
            input.sha !== state.head ||
            !state.methods.includes(input.merge_method.toUpperCase())
          )
            return Response.json({}, { status: 409 });
          state.state = "MERGED";
          state.mergeTitle = input.commit_title ?? "";
          state.mergeBody = input.commit_message ?? "";

          return Response.json({ merged: true, sha: "c".repeat(40) });
        });

      return undefined;
    },
  );

  const original = fixture.options.fetch!;

  const fixtureFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const result = await original(input, init);

      if (state.lost && (init?.method === "PUT" || String(init?.body).includes('"query":"mutation '))) {
        state.lost = false;
        throw new TypeError("Fixture lost mutation response");
      }

      return result;
    },
    { preconnect: fetch.preconnect },
  );

  return { ...fixture, options: { ...fixture.options, fetch: fixtureFetch }, state, created };
}
