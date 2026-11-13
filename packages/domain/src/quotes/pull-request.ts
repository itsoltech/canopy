import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ui, type github } from "@canopy/contracts";
import { QUOTE_LIMITS } from "./quotes.ts";

export function prCitation(
  snapshot: github.PullRequestSnapshot,
  kind: string,
  resourceId: string,
  text: string,
  detail: {
    author?: string | undefined;
    time?: string | undefined;
    url?: string | undefined;
    path?: string | undefined;
    line?: number | undefined;
    firstLine?: number | undefined;
    diffHunk?: string | undefined;
  } = {},
) {
  const ref = snapshot.summary?.ref;

  return create(ui.QuoteSchema, {
    text: text.slice(0, QUOTE_LIMITS.maxTextChars),
    sourceKind: "pull_request",
    sourceAuthor: detail.author ?? "GitHub Actions",
    sourceTime:
      detail.time ?? (snapshot.summary?.verifiedAt ? timestampDate(snapshot.summary.verifiedAt).toISOString() : ""),
    pullRequest: {
      pullRequestId: ref?.id ?? "",
      kind,
      resourceId,
      repository: ref?.repositoryName ?? "",
      number: ref?.number ?? 0,
      url: detail.url || `https://github.com/${ref?.repositoryName}/pull/${ref?.number}`,
      path: detail.path ?? "",
      line: detail.line ?? 0,
      firstLine: detail.firstLine ?? 0,
      diffHunk: (detail.diffHunk ?? "").slice(0, 8_000),
    },
  });
}

export function prCommentCitation(
  snapshot: github.PullRequestSnapshot,
  comment: github.PullRequestTimelineEntry,
  kind = "comment",
  thread?: Pick<github.PullRequestReviewThread, "path" | "line"> &
    Partial<Pick<github.PullRequestReviewThread, "comments">>,
) {
  return prCitation(snapshot, kind, comment.id, comment.body || comment.state, {
    author: comment.author,
    url: comment.url,
    time: comment.createdAt ? timestampDate(comment.createdAt).toISOString() : "",
    path: thread?.path,
    line: thread?.line,
    diffHunk: comment.diffHunk || thread?.comments?.[0]?.diffHunk,
  });
}

export const prCheckFailed = (state: string) =>
  ["failure", "failed", "error", "timed_out", "action_required", "startup_failure"].includes(state);
