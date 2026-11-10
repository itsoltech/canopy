import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { graphPage } from "./timeline-query.ts";
import { graphErrors, jsonMessage, type ReadScope } from "./read-scope.ts";

const check = Schema.Struct({
  __typename: Schema.String,
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  creator: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  checkSuite: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        app: Schema.NullOr(Schema.Struct({ name: Schema.String })),
        workflowRun: Schema.NullOr(Schema.Struct({ databaseId: Schema.Number })),
      }),
    ),
  ),
});

const envelope = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      repository: Schema.NullOr(
        Schema.Struct({
          pullRequest: Schema.NullOr(
            Schema.Struct({
              id: Schema.String,
              headRefOid: Schema.String,
              commits: Schema.Struct({
                nodes: Schema.Array(
                  Schema.Struct({
                    commit: Schema.Struct({
                      oid: Schema.String,
                      statusCheckRollup: Schema.NullOr(
                        Schema.Struct({ contexts: Schema.Struct({ nodes: Schema.Array(check), pageInfo: graphPage }) }),
                      ),
                    }),
                  }),
                ),
              }),
            }),
          ),
        }),
      ),
    }),
  ),
});

export const CHECKS_QUERY = `query CanopyChecks($owner:String!,$name:String!,$number:Int!,$after:String){rateLimit{cost remaining resetAt}
repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid commits(last:1){nodes{commit{oid
statusCheckRollup{contexts(first:50,after:$after){pageInfo{hasNextPage endCursor} nodes{__typename
... on CheckRun{id name status conclusion detailsUrl summary text checkSuite{app{name} workflowRun{databaseId}}}
... on StatusContext{id context state targetUrl creator{login}}}}}}}}}}}`;

export async function checks(scope: ReadScope) {
  return scope.read(github.PullRequestChecksPageSchema, {
    ttl: 15_000,
    path: "/graphql",
    query: CHECKS_QUERY,
    variables: { ...scope.variables, ...(scope.position && { after: scope.position }) },
    project: async (value) => {
      const partial = graphErrors(value);
      const pr = Schema.decodeUnknownSync(envelope)(value).data?.repository?.pullRequest;
      const commit = pr?.commits.nodes[0]?.commit;

      if (!pr || pr.id !== scope.pr.node_id || pr.headRefOid !== scope.head || commit?.oid !== scope.head)
        throw new ConnectError("Checks changed. Refresh this pull request.", Code.FailedPrecondition);
      const connection = commit.statusCheckRollup?.contexts;

      return jsonMessage(
        github.PullRequestChecksPageSchema,
        create(github.PullRequestChecksPageSchema, {
          checks:
            connection?.nodes.map((c) => ({
              nodeId: c.id ?? "",
              name: c.name ?? c.context ?? "Check",
              state: (c.conclusion || c.status || c.state || "unknown").toLowerCase(),
              provider: c.checkSuite?.app?.name ?? c.creator?.login ?? "",
              url: c.detailsUrl ?? c.targetUrl ?? "",
              runId: c.checkSuite?.workflowRun ? String(c.checkSuite.workflowRun.databaseId) : "",
              headSha: scope.head,
              output: [c.summary, c.text].filter(Boolean).join("\n\n").slice(0, 32_768),
            })) ?? [],
          page: scope.page(connection?.pageInfo.hasNextPage ? (connection.pageInfo.endCursor ?? "") : "", partial),
        }),
      );
    },
  });
}

export const workflowRun = Schema.Struct({
  id: Schema.Number,
  head_sha: Schema.String,
  run_attempt: Schema.Number,
  repository: Schema.Struct({ id: Schema.Number }),
  pull_requests: Schema.Array(Schema.Struct({ number: Schema.Number })),
  status: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.String),
});

export const numericId = (value: string) => {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new ConnectError("Check not found", Code.NotFound);

  return value;
};

export async function checkedRun(scope: ReadScope, id: string) {
  const result = await scope.prs.client.read(
    scope.row.id,
    {
      key: `run:${scope.pr.repository_id}:${scope.pr.number}:${scope.head}:${id}`,
      path: `${scope.root}/actions/runs/${numericId(id)}`,
      ttl: 15_000,
      project: async (value) => {
        const item = Schema.decodeUnknownSync(workflowRun)(value);

        if (
          String(item.id) !== id ||
          String(item.repository.id) !== scope.pr.repository_id ||
          item.head_sha !== scope.head ||
          !item.pull_requests.some((p) => p.number === scope.pr.number)
        )
          throw new ConnectError("Check not found", Code.NotFound);

        return value;
      },
    },
    scope.request.refresh,
  );

  return Schema.decodeUnknownSync(workflowRun)(result.payload);
}

export const job = Schema.Struct({
  id: Schema.Number,
  run_id: Schema.Number,
  run_attempt: Schema.Number,
  head_sha: Schema.String,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.String,
});

export async function jobs(scope: ReadScope) {
  const run = await checkedRun(scope, scope.request.resourceId);
  const index = scope.position ? Number(scope.position) : 1;

  if (!Number.isInteger(index) || index < 1 || index > 100)
    throw new ConnectError("Check page not found", Code.NotFound);

  return scope.read(github.PullRequestJobsPageSchema, {
    ttl: 15_000,
    path: `${scope.root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=30&page=${index}`,
    project: async (value) => {
      const list = Schema.decodeUnknownSync(Schema.Struct({ total_count: Schema.Number, jobs: Schema.Array(job) }))(
        value,
      );

      if (list.jobs.some((j) => j.run_id !== run.id || j.run_attempt !== run.run_attempt || j.head_sha !== scope.head))
        throw new ConnectError("Checks changed. Refresh this pull request.", Code.FailedPrecondition);

      return jsonMessage(
        github.PullRequestJobsPageSchema,
        create(github.PullRequestJobsPageSchema, {
          run: {
            id: String(run.id),
            attempt: run.run_attempt,
            name: run.name ?? "Workflow run",
            state: (run.conclusion || run.status || "unknown").toLowerCase(),
            headSha: run.head_sha,
          },
          jobs: list.jobs.map((j) => ({
            id: String(j.id),
            runId: String(j.run_id),
            attempt: j.run_attempt,
            name: j.name,
            state: (j.conclusion || j.status).toLowerCase(),
            url: j.html_url,
            headSha: j.head_sha,
          })),
          page: scope.page(
            index < 100 && index * 30 < list.total_count ? String(index + 1) : "",
            index === 100 && list.total_count > 3000,
            index === 100 && list.total_count > 3000
              ? "Only the first 3000 jobs are available. Open on GitHub to see more."
              : "",
          ),
        }),
      );
    },
  });
}
