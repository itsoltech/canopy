import { Schema } from "effect";
import { mutationFixture } from "./github-mutations.ts";
import { readHead } from "./github-read.ts";
import { githubPrData } from "./github-pr.ts";

/** Local-only Actions fixture. Accepting a request intentionally does not finish a workflow. */
export function ciFixture() {
  const state = {
    attempt: 1,
    head: readHead,
    repository: 777,
    pullRequest: 42,
    status: "completed",
    conclusion: "failure",
    actionsWrite: true,
    push: true,
    jobRun: 123,
    jobAttempt: 1,
    jobHead: readHead,
    lost: false,
    writeStatus: 0,
    writes: [] as Array<{ path: string; body: Schema.JsonObject }>,
    jobs: new Map([
      [456, "failure"],
      [457, "skipped"],
    ]),
  };

  const run = () => ({
    id: 123,
    name: "Build, test and deploy",
    head_sha: state.head,
    run_attempt: state.attempt,
    repository: { id: state.repository },
    pull_requests: [{ number: state.pullRequest }],
    status: state.status,
    conclusion: state.status === "completed" ? state.conclusion : null,
  });

  const job = (id: number) => ({
    id,
    run_id: state.jobRun,
    run_attempt: state.jobAttempt,
    head_sha: state.jobHead,
    name: id === 456 ? "Build" : "Deploy (depends on Build)",
    status: ["queued", "in_progress"].includes(state.jobs.get(id) ?? "") ? state.jobs.get(id) : "completed",
    conclusion: ["queued", "in_progress"].includes(state.jobs.get(id) ?? "") ? null : (state.jobs.get(id) ?? "failure"),
    html_url: `https://github.com/itsoltech/canopy/actions/runs/123/job/${id}`,
  });

  const fixture = mutationFixture({
    graph: (query) => {
      if (query.includes("CanopyPullRequest")) {
        const pr = githubPrData();

        return Response.json({
          data: {
            repository: {
              databaseId: 777,
              viewerPermission: state.push ? "WRITE" : "READ",
              pullRequest: {
                ...pr,
                headRefOid: readHead,
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: readHead,
                        statusCheckRollup: {
                          state: state.status === "completed" ? state.conclusion.toUpperCase() : "PENDING",
                          contexts: { nodes: [], totalCount: 2, pageInfo: { hasNextPage: false } },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }

      if (query.includes("CanopyChecks"))
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                id: "PR_fixture_42",
                headRefOid: readHead,
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: readHead,
                        statusCheckRollup: {
                          contexts: {
                            nodes: [
                              {
                                __typename: "CheckRun",
                                id: "CHECK_CI",
                                name: "Build, test and deploy",
                                status: state.status.toUpperCase(),
                                conclusion: state.status === "completed" ? state.conclusion.toUpperCase() : null,
                                detailsUrl: "https://github.com/itsoltech/canopy/actions/runs/123",
                                checkSuite: { app: { name: "GitHub Actions" }, workflowRun: { databaseId: 123 } },
                              },
                              {
                                __typename: "StatusContext",
                                id: "EXTERNAL",
                                context: "External CI",
                                state: "SUCCESS",
                                targetUrl: "https://ci.example.test/check",
                                creator: { login: "external-ci" },
                              },
                            ],
                            pageInfo: { hasNextPage: false, endCursor: null },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
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
                issues: "write",
                checks: "read",
                actions: state.actionsWrite ? "write" : "read",
              },
              suspended_at: null,
            },
          ],
        });

      if (path === "/repos/itsoltech/canopy")
        return Response.json({
          id: 777,
          full_name: "itsoltech/canopy",
          private: true,
          permissions: { pull: true, push: state.push },
        });

      if (!path.startsWith("/repos/itsoltech/canopy/actions/")) return undefined;

      if (request.method === "GET") {
        if (path.endsWith("/runs/123")) return Response.json(run());

        if (path.endsWith("/jobs/456") || path.endsWith("/jobs/457"))
          return Response.json(job(Number(path.split("/").at(-1))));

        if (/\/runs\/123\/attempts\/\d+\/jobs$/.test(path))
          return Response.json({ total_count: 2, jobs: [job(456), job(457)] });

        if (/\/(runs|jobs)\/\d+$/.test(path)) return Response.json({}, { status: 404 });

        return undefined;
      }

      return request.json().then((raw) => {
        const body = Schema.decodeUnknownSync(Schema.JsonObject)(raw);
        state.writes.push({ path, body });

        if (state.lost) {
          state.lost = false;

          return Response.json({}, { status: 502 });
        }

        if (path.endsWith("/jobs/456/rerun")) {
          // The job endpoint, rather than a workflow dispatch, includes downstream jobs in GitHub.
          state.jobs.set(456, "queued");
          state.jobs.set(457, "queued");
        }

        if (/\/(rerun|rerun-failed-jobs)$/.test(path)) {
          state.jobs.set(456, "queued");
          state.jobs.set(457, "queued");
        }

        return new Response(path.endsWith("/jobs/456/rerun") ? "" : null, {
          status: state.writeStatus || (path.endsWith("/cancel") ? 202 : 201),
        });
      });
    },
  });

  return { ...fixture, state };
}
