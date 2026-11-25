import { Schema } from "effect";
import { detectionPull } from "./github-detection.ts";
import { githubPrData } from "./github-pr.ts";
import { readFixture, readHead, readBase } from "./github-read.ts";

export interface PollRequest {
  resource: string;
  path: string;
  status: number;
  conditional: boolean;
  at: number;
}

/** Stable REST validators and an observable transport, including legacy status contexts. No live API. */
export function pollingFixture(paginatedChecks = false) {
  const state = {
    pr: "OPEN",
    running: true,
    /** The check's conclusion once it stopped running. */
    conclusion: "SUCCESS",
    /** A second check appears while workflows fan out, then either runs or passes. */
    tests: "absent",
    legacyRunning: false,
    head: readHead,
    base: readBase,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    updatedAt: "2026-11-10T12:00:00Z",
    version: 1,
    pollInterval: 0,
    checkPages: 1,
  };

  const branch = githubPrData().headRefName;
  let discover = false;
  const previousHeads = new Map<string, typeof state>();

  const envelope = (pullRequest: Schema.JsonObject) =>
    Response.json({
      data: {
        repository: { databaseId: 777, pullRequest },
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-11-12T23:00:00Z" },
      },
    });

  const fixture = readFixture(
    (query, variables) => {
      const kind = query.match(/query (\w+)/)?.[1] ?? "";

      if (!["CanopyPullRequest", "CanopyChecks"].includes(kind)) return;

      if (variables["number"] !== 42) return;

      if (kind === "CanopyChecks" && paginatedChecks) return;
      fixture.counts.set(kind, (fixture.counts.get(kind) ?? 0) + 1);

      const check = {
        __typename: "CheckRun",
        id: `CHECK_${state.head.slice(0, 4)}`,
        name: "Build",
        status: state.running ? "IN_PROGRESS" : "COMPLETED",
        conclusion: state.running ? null : state.conclusion,
        checkSuite: { app: { name: "Actions" }, workflowRun: { databaseId: 123 } },
      };

      const nodes = [check];

      if (state.tests !== "absent")
        nodes.push({
          ...check,
          id: `TEST_${state.head.slice(0, 4)}`,
          name: "Tests",
          status: state.tests === "pending" ? "IN_PROGRESS" : "COMPLETED",
          conclusion: state.tests === "pending" ? null : "SUCCESS",
          checkSuite: { app: { name: "Actions" }, workflowRun: { databaseId: 124 } },
        });

      const statusCheckRollup =
        state.checkPages === 0
          ? null
          : {
              state: state.running || state.legacyRunning || state.tests === "pending" ? "PENDING" : state.conclusion,
              contexts: { totalCount: nodes.length, nodes, pageInfo: { hasNextPage: false, endCursor: null } },
            };

      const commits = { nodes: [{ commit: { oid: state.head, statusCheckRollup } }] };

      if (kind === "CanopyPullRequest") {
        const pr = githubPrData(42, state.pr);

        return envelope(
          Schema.decodeUnknownSync(Schema.JsonObject)({
            ...pr,
            updatedAt: state.updatedAt,
            headRefOid: state.head,
            baseRefOid: state.base,
            mergeable: state.mergeable,
            mergeStateStatus: state.mergeStateStatus,
            ...(discover && { headRepository: { databaseId: 777, nameWithOwner: "itsoltech/canopy" } }),
            commits: paginatedChecks ? pr.commits : commits,
          }),
        );
      }

      return envelope({ id: "PR_fixture_42", headRefOid: state.head, commits });
    },
    (request) => {
      const url = new URL(request.url);
      const root = "/repos/itsoltech/canopy";

      if (!url.pathname.startsWith(`${root}/`)) return;

      if (discover && url.pathname === `${root}/pulls` && url.searchParams.get("head") === `itsoltech:${branch}`)
        return Response.json([detectionPull(42, branch, state.head)]);

      const [, sha, resource] =
        /^commits\/([a-f0-9]{40})\/(check-runs|status)$/.exec(url.pathname.slice(root.length + 1)) ?? [];

      const commit = sha === state.head ? state : previousHeads.get(sha ?? "");
      let body: Schema.JsonObject;
      let etag: string;

      if (url.pathname === `${root}/pulls/42`) {
        body = {
          node_id: "PR_fixture_42",
          updated_at: state.updatedAt,
          state: state.pr === "OPEN" ? "open" : "closed",
          merged: state.pr === "MERGED",
          draft: false,
          head: { sha: state.head },
          base: { sha: state.base },
          mergeable: state.mergeable === "UNKNOWN" ? null : state.mergeable === "MERGEABLE",
          mergeable_state: state.mergeStateStatus.toLowerCase(),
        };
        etag = JSON.stringify(
          `metadata-${state.updatedAt}-${state.head}-${state.base}-${state.pr}-${state.mergeable}-${state.mergeStateStatus}`,
        );
      } else if (commit && resource === "check-runs") {
        const runs = [{ status: commit.running ? "in_progress" : "completed" }];

        if (commit.tests !== "absent") runs.push({ status: commit.tests === "pending" ? "in_progress" : "completed" });
        body = {
          total_count: Math.max(0, commit.checkPages * 100 - 100 + runs.length),
          check_runs: commit.checkPages === 0 ? [] : runs,
        };
        etag = JSON.stringify(
          `checks-${commit.version}-${commit.running}-${commit.tests}-${commit.checkPages}-${url.searchParams.get("page")}`,
        );
      } else if (commit && resource === "status") {
        body =
          commit.checkPages === 0
            ? { total_count: 0, statuses: [] }
            : { total_count: 1, statuses: [{ state: commit.legacyRunning ? "pending" : "success" }] };
        etag = JSON.stringify(`statuses-${commit.version}-${commit.legacyRunning}-${commit.checkPages}`);
      } else return;
      const headers = { etag, ...(state.pollInterval && { "x-poll-interval": String(state.pollInterval) }) };

      return request.headers.get("if-none-match") === etag
        ? new Response(null, { status: 304, headers })
        : Response.json(body, { headers });
    },
  );

  const requests: PollRequest[] = [];
  const upstream = fixture.options.fetch!;

  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const path = new URL(request.url).pathname;

      const graph =
        path === "/graphql"
          ? Schema.decodeUnknownSync(Schema.Struct({ query: Schema.String }))(await request.clone().json())
          : undefined;

      const response = await upstream(request.url, init);
      requests.push({
        path,
        resource: graph?.query.match(/query (\w+)/)?.[1] ?? path,
        status: response.status,
        conditional: request.headers.has("if-none-match"),
        at: fixture.options.now!(),
      });

      return response;
    },
    { preconnect: fetch.preconnect },
  );

  return {
    ...fixture,
    options: { ...fixture.options, fetch: transport },
    state,
    requests,
    discoverBranch: () => {
      discover = true;

      return branch;
    },
    pushHead: (sha: string) => {
      previousHeads.set(state.head, { ...state });
      state.head = sha;
    },
    timelineVersion: (value: string) => {
      fixture.timelineVersion(value);
      state.updatedAt = "2026-11-10T12:01:00Z";
    },
  };
}
