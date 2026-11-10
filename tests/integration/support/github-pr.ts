import { Provider } from "@canopy/contracts";
import { randomBytes } from "node:crypto";
import { Match, Schema } from "effect";
import { parse } from "graphql";
import { githubFixture } from "./github.ts";
import type { TestGateway } from "./gateway.ts";

export const githubBrowser = () => ({ headers: { "canopy-github-client": randomBytes(32).toString("base64url") } });

/** Deliberately hostile markdown, long metadata and varied CI states, served only by loopback HTTP. */
export function githubPrData(number = 42, state = "OPEN", draft = false) {
  const sha = "a".repeat(40);
  const pageInfo = { hasNextPage: false };
  const checks = ["SUCCESS", "FAILURE", "IN_PROGRESS", "QUEUED", "CANCELLED", "SKIPPED", "NEUTRAL", "TIMED_OUT"];

  return {
    id: `PR_fixture_${number}`,
    number,
    title: `Read-only pull request ${number}: preserve account boundaries and durable links across linked computers with long repository and branch names`,
    state,
    isDraft: draft,
    body:
      '# Summary\n\nRead **carefully**.\n\n```ts\nconst safe = true;\n```\n\n![External image](https://images.example.test/tracker.png)\n\n<script>alert("untrusted")</script>\n\n[Unsafe](javascript:alert(1))\n\n' +
      Array.from(
        { length: 8 },
        (_, i) => `## Detail ${i + 1}\n\nA long description with code, links and images treated as untrusted data.\n\n`,
      ).join(""),
    author: { login: "maintainer-with-a-long-name" },
    updatedAt: "2026-11-10T12:00:00Z",
    createdAt: new Date(Date.UTC(2026, 10, 9, 10, number)).toISOString(),
    baseRefName: "dev",
    headRefName: "feat/a-very-long-feature-branch-name-for-manual-pull-request-linking",
    baseRefOid: "b".repeat(40),
    headRefOid: sha,
    changedFiles: 24,
    additions: 1234,
    deletions: 89,
    labels: {
      nodes: Array.from({ length: 12 }, (_, i) => ({
        name: i === 0 ? "an-extremely-long-label-with-security-and-isolation-details" : `label-${i}`,
        color: ["d73a4a", "a2eeef", "7057ff", "0e8a16", "fbca04", "ffffff"][i % 6]!,
      })),
      pageInfo,
    },
    assignees: { nodes: [{ login: "maintainer" }], pageInfo },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "reviewer-with-a-long-name" } }], pageInfo },
    latestReviews: { nodes: [{ author: { login: "reviewer" }, state: "APPROVED" }], pageInfo },
    commits: {
      nodes: [
        {
          commit: {
            oid: sha,
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                totalCount: 16,
                pageInfo,
                nodes: Array.from({ length: 16 }, (_, i) => ({
                  __typename: "CheckRun",
                  name: `build-and-test-package-${i + 1}-with-long-check-name`,
                  status: Match.value(i % 8).pipe(
                    Match.when(2, () => "IN_PROGRESS"),
                    Match.when(3, () => "QUEUED"),
                    Match.orElse(() => "COMPLETED"),
                  ),
                  conclusion: i % 8 === 2 || i % 8 === 3 ? null : checks[i % 8],
                  detailsUrl: "https://github.com/itsoltech/canopy/actions/runs/123",
                  checkSuite: { app: { name: "GitHub Actions" } },
                })),
              },
            },
          },
        },
      ],
    },
  };
}

export function githubPrFixture() {
  const auth = githubFixture();
  let calls = 0;
  let restCalls = 0;
  let notModified = 0;
  let status = 200;
  let partial = false;
  let gate = Promise.resolve();
  let echo = "";
  let intercept: ((request: Request, user: number) => Response | Promise<Response> | undefined) | undefined;
  let pullRequest = (number: number, state: string, draft: boolean) => githubPrData(number, state, draft);
  auth.handler((request, user) => {
    const response = intercept?.(request, user);

    if (response) return response;
    const url = new URL(request.url);

    if (/^\/user\/installations\/\d+\/repositories$/.test(url.pathname))
      return Response.json({
        total_count: 1,
        repositories: [
          { id: 777, full_name: "itsoltech/canopy", private: true, permissions: { pull: true, push: true } },
        ],
      });

    if (url.pathname === "/repos/itsoltech/canopy") {
      restCalls++;

      if (request.headers.get("if-none-match") === '"repository-v1"') {
        notModified++;

        return new Response(null, {
          status: 304,
          headers: { etag: '"repository-v1"', "x-ratelimit-remaining": "4999" },
        });
      }

      return Response.json(
        { id: 777, full_name: "itsoltech/canopy", private: true, permissions: { pull: true, push: true } },
        { headers: { etag: '"repository-v1"', "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999" } },
      );
    }

    if (url.pathname !== "/graphql") return;
    calls++;

    return (async () => {
      await gate;

      if (status !== 200)
        return Response.json(
          { message: status === 429 ? "secondary rate limit" : "unavailable" },
          { status, headers: status === 429 ? { "retry-after": "60" } : {} },
        );

      const query = Schema.decodeUnknownSync(
        Schema.Struct({ query: Schema.String, variables: Schema.Struct({ number: Schema.Number }) }),
      )(await request.json());

      try {
        parse(query.query);
      } catch {
        return Response.json({ errors: [{ type: "GRAPHQL_PARSE_FAILED" }] }, { status: 400 });
      }

      const number = query.variables.number;

      const state = Match.value(number).pipe(
        Match.when(43, () => "MERGED"),
        Match.when(44, () => "CLOSED"),
        Match.orElse(() => "OPEN"),
      );

      const pr = pullRequest(number, state, number === 45);
      pr.title += ` · account ${user}${echo}`;

      return Response.json({
        data: {
          repository: { databaseId: 777, pullRequest: { ...pr, ...(partial && { labels: null }) } },
          rateLimit: { cost: 3, remaining: 4990, resetAt: new Date(auth.options.now!() + 3_600_000).toISOString() },
        },
        ...(partial && { errors: [{ type: "INTERNAL" }] }),
      });
    })();
  });

  return {
    ...auth,
    intercept: (value: typeof intercept) => {
      intercept = value;
    },
    pullRequest: (value: typeof pullRequest) => {
      pullRequest = value;
    },
    get calls() {
      return calls;
    },
    get restCalls() {
      return restCalls;
    },
    get notModified() {
      return notModified;
    },
    status: (value: number) => {
      status = value;
    },
    gate: (value: Promise<void>) => {
      gate = value;
    },
    partial: (value: boolean) => {
      partial = value;
    },
    echoText: (value: string) => {
      echo = value;
    },
  };
}

export async function connectGitHub(gw: TestGateway, fixture: ReturnType<typeof githubPrFixture>, user = 101) {
  fixture.user(user);
  fixture.mode("success");
  const browser = githubBrowser();
  const attempt = (await gw.api.beginGitHubDeviceAuth({ clientRequestId: crypto.randomUUID() }, browser)).attempt!;
  fixture.advance(5000);
  await gw.core.github.device.tick();
  const id = (await gw.api.getGitHubDeviceAuth({ attemptId: attempt.id }, browser)).attempt!.accountId;
  await gw.api.listGitHubInstallations({ accountId: id });

  return id;
}

export async function githubThread(gw: TestGateway) {
  const project = (await gw.api.createProject({ name: "GitHub fixture" })).project!.id;

  const workspace = (
    await gw.api.createWorkspace({ projectId: project, workerId: gw.workerId, rootPath: "/repo/github-fixture" })
  ).workspace!.id;

  return (
    await gw.api.createThread({
      projectId: project,
      workspaceId: workspace,
      provider: Provider.CODEX,
      title: "Manual pull request",
      clientRequestId: crypto.randomUUID(),
    })
  ).thread!.id;
}
