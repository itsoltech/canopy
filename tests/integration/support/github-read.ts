import { Schema } from "effect";
import { parse } from "graphql";
import { githubPrData, githubPrFixture, connectGitHub, githubThread } from "./github-pr.ts";
import type { TestGateway } from "./gateway.ts";

export const readHead = "a".repeat(40);
export const readBase = "b".repeat(40);
const date = "2026-11-10T12:00:00Z";
const author = { login: "fixture-reviewer" };
const source = "https://github.com/itsoltech/canopy/pull/42";

export function fixtureFilePath(i: number) {
  if (i === 0) return "src/safe.ts";

  if (i === 1) return "assets/binary.png";

  if (i === 2) return "renamed.ts";

  return `src/file-${i}.ts`;
}

const input = Schema.Struct({
  query: Schema.String,
  variables: Schema.Struct({
    number: Schema.optional(Schema.Number),
    after: Schema.optional(Schema.String),
    before: Schema.optional(Schema.String),
    first: Schema.optional(Schema.Number),
    reply: Schema.optional(Schema.String),
    id: Schema.optional(Schema.String),
  }),
});

function connection<T>(items: T[], position = "", size = 50, reverse = false) {
  const offset = Number(position || (reverse ? items.length : 0));
  const start = reverse ? Math.max(0, offset - size) : offset;
  const end = reverse ? offset : Math.min(items.length, start + size);

  return {
    nodes: items.slice(start, end),
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: String(start),
      endCursor: String(end),
    },
  };
}

export function readFixture(
  graph?: (
    query: string,
    variables: Schema.JsonObject,
    user: number,
  ) => Response | undefined | Promise<Response | undefined>,
  rest?: (request: Request, user: number) => Response | undefined,
) {
  const fixture = githubPrFixture();
  let head = readHead;
  let status = 200;
  let partial = false;
  let race = false;
  let logs = `\u001b[31mFAILED\u001b[0m\nAuthorization: Bearer private-value\n` + "fixture log line\n".repeat(2500);
  let logRedirect = "";
  let attempt = 1;
  let timelineVersion = "";
  const counts = new Map<string, number>();

  const checkItems = () =>
    Array.from({ length: 137 }, (_, i) => ({
      __typename: "CheckRun",
      id: `CHECK_${i}`,
      name: `Very long build and test check ${i}`,
      status: "COMPLETED",
      conclusion:
        ["FAILURE", "TIMED_OUT", "IN_PROGRESS", "SUCCESS", "SKIPPED", "CANCELLED", "NEUTRAL", "QUEUED"][i % 8] ??
        "NEUTRAL",
      detailsUrl: source,
      summary: "Check output",
      text: "<script>untrusted</script>",
      checkSuite: { app: { name: "GitHub Actions" }, workflowRun: { databaseId: 123 } },
    }));

  const events = () =>
    Array.from({ length: 153 }, (_, i) => {
      const common = { id: `EVENT_${i}`, author, actor: author, createdAt: date, url: source };

      if (i % 4 === 0)
        return {
          ...common,
          __typename: "PullRequestReview",
          state: "CHANGES_REQUESTED",
          body: `Review ${i}${timelineVersion}`,
        };

      if (i % 4 === 1) return { ...common, __typename: "IssueComment", body: `Comment ${i}${timelineVersion}` };

      if (i % 4 === 2)
        return {
          __typename: "PullRequestCommit",
          commit: {
            oid: String(i).padStart(40, "a"),
            messageHeadline: `Commit ${i}`,
            committedDate: date,
            url: source,
            author: { name: author.login, user: author },
          },
        };

      return { ...common, __typename: "LabeledEvent", label: { name: "security" } };
    });

  const review = (id: string, reply = "") => ({
    id,
    path: "src/safe.ts",
    line: 3,
    isResolved: false,
    isOutdated: false,
    pullRequest: { id: "PR_fixture_42" },
    comments: connection(
      Array.from({ length: 127 }, (_, i) => ({
        id: `${id}_COMMENT_${i}`,
        body: `Finding reply ${i}`,
        url: source,
        createdAt: date,
        author,
        originalCommit: { oid: head },
      })),
      reply,
    ),
  });

  const job = (id: number) => ({
    id,
    run_id: 123,
    run_attempt: attempt,
    head_sha: head,
    name: `Job ${id}`,
    status: "completed",
    conclusion: "failure",
    html_url: source,
  });

  fixture.pullRequest((number, state, draft) => ({ ...githubPrData(number, state, draft), headRefOid: head }));
  fixture.intercept((request, user) => {
    const url = new URL(request.url);
    const key = url.pathname;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const extra = rest?.(request, user);

    if (extra) return extra;

    if (key === "/graphql")
      return (async () => {
        const raw = await request.json();
        const { query, variables: v } = Schema.decodeUnknownSync(input)(raw);
        parse(query);

        if (graph) {
          const variables = Schema.decodeUnknownSync(Schema.Struct({ variables: Schema.JsonObject }))(raw).variables;
          const extra = await graph(query, variables, user);

          if (extra) return extra;
        }

        const kind = query.match(/query (\w+)/)?.[1] ?? "";
        counts.set(kind, (counts.get(kind) ?? 0) + 1);

        if (status !== 200)
          return Response.json({}, { status, headers: status === 429 ? { "retry-after": "60" } : {} });
        const pr = { ...githubPrData(v.number ?? 42), headRefOid: head, changedFiles: 300 };
        let value: Schema.JsonObject;

        if (kind === "CanopyTimeline")
          value = {
            repository: {
              pullRequest: {
                id: pr.id,
                timelineItems: connection(events(), v.before ?? v.after, 50, !v.first),
              },
            },
          };
        else if (kind === "CanopyChecks")
          value = {
            repository: {
              pullRequest: {
                id: pr.id,
                headRefOid: head,
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: head,
                        statusCheckRollup: {
                          contexts: connection(checkItems(), v.after),
                        },
                      },
                    },
                  ],
                },
              },
            },
          };
        else if (kind === "CanopyReviewThreads")
          value = {
            repository: {
              pullRequest: {
                id: pr.id,
                reviewThreads: connection(
                  Array.from({ length: 113 }, (_, i) => review(`THREAD_${i}`)),
                  v.after,
                  30,
                ),
              },
            },
          };
        else if (kind === "CanopyViewed")
          value = {
            repository: {
              pullRequest: {
                id: pr.id,
                headRefOid: head,
                baseRefOid: readBase,
                files: connection(
                  Array.from({ length: 300 }, (_, i) => ({
                    path: fixtureFilePath(i),
                    viewerViewedState: "UNVIEWED",
                  })),
                  v.after,
                  100,
                ),
              },
            },
          };
        else if (kind === "CanopyReviewReplies") value = { node: review(v.id ?? "", v.reply) };
        else if (kind === "CanopyHeaders")
          value = Schema.decodeUnknownSync(Schema.JsonObject)({
            repository: Object.fromEntries(
              [...query.matchAll(/(p\d+):pullRequest\(number:(\d+)\)/g)].map((match) => [
                match[1],
                {
                  ...githubPrData(Number(match[2])),
                  headRefOid: head,
                },
              ]),
            ),
          });
        else value = Schema.decodeUnknownSync(Schema.JsonObject)({ repository: { databaseId: 777, pullRequest: pr } });

        return Response.json({
          data: { ...value, rateLimit: { cost: 1, remaining: 4999, resetAt: date } },
          ...(partial && { errors: [{ type: "INTERNAL" }] }),
        });
      })();

    if (!key.startsWith("/repos/itsoltech/canopy/")) return;

    if (key.endsWith("/releases")) return Response.json([{ tag_name: "v1.0.0", draft: false, prerelease: false }]);

    if (status !== 200) return Response.json({}, { status, headers: status === 429 ? { "retry-after": "60" } : {} });
    const page = Number(url.searchParams.get("page") || "1");
    const next = page * 30 < 300;
    const headers = { etag: '"read-page-v1"', ...(next && { link: '<https://api.github.com/fixed>; rel="next"' }) };

    if (!race && request.headers.get("if-none-match") === headers.etag)
      return new Response(null, { status: 304, headers });

    if (key.endsWith("/pulls/42/files") || /\/commits\/[a-f0-9]{40}$/.test(key)) {
      const files = Array.from({ length: 30 }, (_, n) => {
        const index = (page - 1) * 30 + n;
        const binary = index === 1;
        const rename = index === 2;

        return {
          filename:
            index === 0 ? "src/safe.ts" : binary ? "assets/binary.png" : rename ? "renamed.ts" : `src/file-${index}.ts`,
          ...(rename && { previous_filename: "old.ts" }),
          status: rename ? "renamed" : "modified",
          additions: binary || rename ? 0 : 1,
          deletions: binary || rename ? 0 : 1,
          blob_url: source,
          ...(!binary &&
            !rename && {
              patch: index === 3 ? "@@ -1 +1 @@\n-" + "x".repeat(270_000) + "\n+y" : "@@ -1 +1 @@\n-old\n+new",
            }),
        };
      });

      if (race) {
        race = false;
        head = "c".repeat(40);
      }

      return Response.json(key.includes("/pulls/") ? files : { files }, { headers });
    }

    if (key.endsWith("/pulls/42/commits"))
      return Response.json([{ sha: head, commit: { message: "Safe change", author: { name: author.login } } }]);

    if (key.endsWith("/actions/runs/123"))
      return Response.json({
        id: 123,
        head_sha: head,
        run_attempt: attempt,
        repository: { id: 777 },
        pull_requests: [{ number: 42 }],
      });

    if (/\/attempts\/\d+\/jobs$/.test(key))
      return Response.json(
        {
          total_count: 123,
          jobs: Array.from({ length: Math.min(30, 123 - (page - 1) * 30) }, (_, i) => job((page - 1) * 30 + i + 1)),
        },
        { headers },
      );

    if (/\/actions\/jobs\/\d+$/.test(key)) return Response.json(job(Number(key.split("/").at(-1))));

    if (/\/actions\/jobs\/\d+\/logs$/.test(key))
      return logRedirect
        ? new Response(null, { status: 302, headers: { location: logRedirect } })
        : new Response(`${logs}\n${fixture.secrets.slice(-2).join(" ")}`, { headers });

    return Response.json({}, { status: 404 });
  });

  return {
    ...fixture,
    counts,
    head: (value: string) => {
      head = value;
    },
    status: (value: number) => {
      status = value;
    },
    partial: (value: boolean) => {
      partial = value;
    },
    race: () => {
      race = true;
    },
    logs: (value: string) => {
      logs = value;
    },
    logRedirect: (value: string) => {
      logRedirect = value;
    },
    attempt: (value: number) => {
      attempt = value;
    },
    timelineVersion: (value: string) => {
      timelineVersion = value;
    },
  };
}

export async function linkedRead(gw: TestGateway, fixture: ReturnType<typeof readFixture>) {
  const account = await connectGitHub(gw, fixture);
  const thread = await githubThread(gw);
  await gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });
  const list = await gw.api.linkThreadPullRequest({ threadId: thread, url: source });

  return { account, thread, pr: list.links[0]!.summary!.ref!.id };
}
