import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { digest, readScope, type ReadScope } from "./read-scope.ts";
import type { GitHubPullRequests } from "./pull-requests.ts";

export type ProbeKind = "metadata" | "checks" | "statuses";

export interface ProbeTarget {
  kind: ProbeKind;
  page: number;
}

const metadata = Schema.Struct({
  node_id: Schema.String,
  updated_at: Schema.String,
  state: Schema.String,
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  head: Schema.Struct({ sha: Schema.String }),
  base: Schema.Struct({ sha: Schema.String }),
});

const checkRuns = Schema.Struct({
  total_count: Schema.Number,
  check_runs: Schema.Array(Schema.Struct({ status: Schema.String })),
});

const statuses = Schema.Struct({
  total_count: Schema.Number,
  statuses: Schema.Array(Schema.Struct({ state: Schema.String })),
});

const signal = Schema.Struct({
  revision: Schema.String,
  running: Schema.Boolean,
  pages: Schema.Number,
});

export type ProbeSignal = typeof signal.Type;

export const terminalSnapshot = (snapshot: github.PullRequestSnapshot) =>
  ["merged", "closed"].includes(snapshot.summary?.state ?? "");

export async function watchScope(prs: GitHubPullRequests, id: string) {
  const pr = await prs.accounts.run((s) => s.prOwned(prs.accounts.owner, id));
  const snapshot = (await prs.cached(pr.repository_name, pr.number)) ?? (await prs.load(pr.repository_name, pr.number));

  return readScope(prs, create(github.PullRequestPageRequestSchema, { pullRequestId: id }), "watch", true, snapshot);
}

export function metadataRevision(snapshot: github.PullRequestSnapshot) {
  return digest(
    JSON.stringify([
      snapshot.summary?.updatedAt ? timestampDate(snapshot.summary.updatedAt).toISOString() : "",
      snapshot.summary?.headSha,
      snapshot.baseSha,
      snapshot.summary?.state,
    ]),
  );
}

/** Real REST validators, never a fictional ETag on GraphQL POST. Keep their payloads lightweight. */
export async function readProbe(scope: ReadScope, target: ProbeTarget, abort: AbortSignal) {
  const { prs, pr, row, head, root } = scope;
  const key = `watch:${pr.repository_id}:${pr.number}:${scope.binding}:${target.kind}:${target.page}`;
  const previous = await prs.client.cached(row, key);

  const path =
    target.kind === "metadata"
      ? `${root}/pulls/${pr.number}`
      : `${root}/commits/${head}/${target.kind === "checks" ? "check-runs" : "status"}?per_page=100&page=${target.page}`;

  const value = await prs.client.read(row.id, {
    key,
    path,
    background: true,
    signal: abort,
    ttl: target.kind === "metadata" ? 60_000 : 15_000,
    project: async (value, headers) => {
      if (target.kind === "metadata") {
        const data = Schema.decodeUnknownSync(metadata)(value);

        if (data.node_id !== pr.node_id)
          throw new ConnectError("Pull request changed. Refresh.", Code.FailedPrecondition);

        return {
          revision: digest(
            JSON.stringify([
              new Date(data.updated_at).toISOString(),
              data.head.sha,
              data.base.sha,
              data.merged ? "merged" : data.state === "closed" ? "closed" : data.draft ? "draft" : "open",
            ]),
          ),
          running: false,
          pages: 1,
        };
      }

      const data =
        target.kind === "checks"
          ? Schema.decodeUnknownSync(checkRuns)(value)
          : Schema.decodeUnknownSync(statuses)(value);

      const running =
        "check_runs" in data
          ? data.check_runs.some((item) => item.status !== "completed")
          : data.statuses.some((item) => item.state === "pending");

      return {
        revision: headers.get("etag") || digest(JSON.stringify(value)),
        running,
        pages: Math.max(1, Math.ceil(data.total_count / 100)),
      };
    },
  });

  const current = Schema.decodeUnknownSync(signal)(value.payload);
  const prior = previous?.payload ? Schema.decodeUnknownSync(signal)(previous.payload) : undefined;

  return {
    ...current,
    changed:
      target.kind === "metadata"
        ? current.revision !== metadataRevision(scope.snapshot)
        : !!prior && current.revision !== prior.revision,
    expires: Number(value.expires_at),
  };
}
