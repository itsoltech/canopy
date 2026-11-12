import { create, fromJsonString, toJson } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { github } from "@canopy/contracts";
import { Schema } from "effect";
import type { GitHubPullRequests } from "./pull-requests.ts";
import type { PullRequestRow } from "./store-pull-requests.ts";
import { graphErrors } from "./read-scope.ts";

const header = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  headRefOid: Schema.String,
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({
          statusCheckRollup: Schema.NullOr(
            Schema.Struct({ state: Schema.String, contexts: Schema.Struct({ totalCount: Schema.Number }) }),
          ),
        }),
      }),
    ),
  }),
});

const envelope = Schema.Struct({
  data: Schema.Struct({ repository: Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(header))) }),
});

const fields = `id number title state isDraft headRefOid commits(last:1){nodes{commit{statusCheckRollup{state contexts{totalCount}}}}}`;

/** Known PRs only, up to ten aliases per repository. No descriptions, discovery, files or logs. */
export async function pollHeaders(prs: GitHubPullRequests, rows: readonly PullRequestRow[], ttl = 300_000) {
  if (!rows.length) return;
  const name = rows[0]!.repository_name;
  const { row } = await prs.repositories.selected(name);
  const batch = rows.slice(0, 10);

  const value = await prs.client.read(row.id, {
    key: `poll:${rows[0]!.repository_id}:${batch.map((p) => p.number).join(",")}`,
    path: "/graphql",
    background: true,
    ttl,
    variables: { owner: name.split("/")[0]!, name: name.split("/")[1]! },
    query: `query CanopyHeaders($owner:String!,$name:String!){rateLimit{cost remaining resetAt} repository(owner:$owner,name:$name){${batch.map((p, i) => `p${i}:pullRequest(number:${p.number}){${fields}}`).join(" ")}}}`,
    project: async (data) => {
      graphErrors(data);

      return data;
    },
  });

  const data = Schema.decodeUnknownSync(envelope)(value.payload).data.repository;

  for (const [i, p] of batch.entries()) {
    const h = data?.[`p${i}`];

    if (!h || h.id !== p.node_id || h.number !== p.number) continue;
    const cached = await prs.client.cached(row, `summary:${p.repository_id}:${p.number}`);

    if (!cached?.payload) continue;

    if (Number(cached.verified_at) > Number(value.verified_at)) continue;
    const snapshot = fromJsonString(github.PullRequestSnapshotSchema, JSON.stringify(cached.payload));

    if (!snapshot.summary) continue;
    const checks = h.commits.nodes[0]?.commit.statusCheckRollup;

    const summary = create(github.PullRequestSummarySchema, {
      ...snapshot.summary,
      title: h.title,
      state: h.isDraft ? "draft" : h.state.toLowerCase(),
      headSha: h.headRefOid,
      checksState: checks?.state.toLowerCase() ?? "unknown",
      checksCount: checks?.contexts.totalCount ?? 0,
      verifiedAt: timestampFromDate(new Date(value.verified_at ?? prs.accounts.http.now())),
    });

    await prs.accounts.run((s) =>
      s.cacheHeader(
        row,
        p.repository_id,
        p.number,
        Schema.decodeUnknownSync(Schema.JsonObject)(toJson(github.PullRequestSummarySchema, summary)),
      ),
    );
  }

  await prs.changed(rows[0]!.repository_id);
}

/** Uses the existing sweep lifecycle. Durable cache leases/expiry fence batches after a restart. */
export class GitHubBackground {
  #timer: ReturnType<typeof setInterval> | undefined;
  #flight: Promise<void> | undefined;
  constructor(readonly prs: GitHubPullRequests) {}
  start() {
    this.#timer ??= setInterval(() => void this.tick().catch(() => {}), 60_000);
    this.#timer.unref?.();
  }
  tick() {
    return (this.#flight ??= this.poll().finally(() => {
      this.#flight = undefined;
    }));
  }
  private async poll() {
    await this.prs.repositories.refresh();
    const rows = await this.prs.accounts.run((s) => s.pollCandidates(this.prs.accounts.owner));
    const groups = Map.groupBy(rows, (p) => p.repository_id);

    for (const group of groups.values())
      for (let i = 0; i < group.length; i += 10) {
        try {
          await pollHeaders(this.prs, group.slice(i, i + 10));
        } catch {
          /* Next scheduled tick respects durable backoff. */
        }
      }
  }
  async stop() {
    clearInterval(this.#timer);
    await this.#flight;
  }
}
