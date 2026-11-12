import { Schema } from "effect";
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
    legacyRunning: false,
    head: readHead,
    updatedAt: "2026-11-10T12:00:00Z",
    version: 1,
    pollInterval: 0,
    checkPages: 1,
  };

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

      if (kind === "CanopyPullRequest") {
        const pr = githubPrData(42, state.pr);
        pr.updatedAt = state.updatedAt;
        pr.headRefOid = state.head;

        return envelope(Schema.decodeUnknownSync(Schema.JsonObject)(pr));
      }

      return envelope({
        id: "PR_fixture_42",
        headRefOid: state.head,
        commits: {
          nodes: [
            {
              commit: {
                oid: state.head,
                statusCheckRollup: {
                  state: state.running || state.legacyRunning ? "PENDING" : "SUCCESS",
                  contexts: {
                    totalCount: 1,
                    nodes: [
                      {
                        __typename: "CheckRun",
                        id: "CHECK_1",
                        name: "Build",
                        status: state.running ? "IN_PROGRESS" : "COMPLETED",
                        conclusion: state.running ? null : "SUCCESS",
                        checkSuite: { app: { name: "Actions" }, workflowRun: { databaseId: 123 } },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          ],
        },
      });
    },
    (request) => {
      const url = new URL(request.url);
      const root = "/repos/itsoltech/canopy";
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
          base: { sha: readBase },
        };
        etag = JSON.stringify(`metadata-${state.updatedAt}-${state.head}-${state.pr}`);
      } else if (url.pathname.endsWith("/check-runs")) {
        body = {
          total_count: state.checkPages * 100 - 99,
          check_runs: [{ status: state.running ? "in_progress" : "completed" }],
        };
        etag = JSON.stringify(`checks-${state.version}-${state.running}-${url.searchParams.get("page")}`);
      } else if (url.pathname === `${root}/commits/${state.head}/status`) {
        body = { total_count: 1, statuses: [{ state: state.legacyRunning ? "pending" : "success" }] };
        etag = JSON.stringify(`statuses-${state.version}-${state.legacyRunning}`);
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
    timelineVersion: (value: string) => {
      fixture.timelineVersion(value);
      state.updatedAt = "2026-11-10T12:01:00Z";
    },
  };
}
