import { create, fromJsonString } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { prCheckFailed, prCitation, prCommentCitation } from "@canopy/domain";
import { Schema } from "effect";
import type { GatewayCore } from "../core/core.ts";
import { InvalidError } from "../core/core-context.ts";
import type { StoredQuote } from "../store/quotes.ts";
import { uuid } from "./records.ts";

const missing = () => new InvalidError("Citation source unavailable. Refresh the pull request and add it again.");

/** Resolve source identity from the durable owner-scoped cache, never client metadata or GitHub. */
export async function resolvePullRequestCitation(core: GatewayCore, thread: string, quote: StoredQuote) {
  const source = quote.pullRequest;

  if (
    !source ||
    !uuid(source.pullRequestId) ||
    !["comment", "review", "review_comment", "check", "job", "log"].includes(source.kind) ||
    !source.resourceId ||
    source.resourceId.length > 200
  )
    throw missing();

  const [cached] = await core.github.run((s) =>
    s.citationCache(core.github.owner, thread, source.pullRequestId, source.kind, source.resourceId),
  );

  if (!cached) throw missing();

  const snapshot = {
    summary: { ref: { id: source.pullRequestId, repositoryName: cached.repository_name, number: cached.number } },
  };

  // A minimal protobuf snapshot avoids trusting any descriptive fields from the client.
  const context = create(github.PullRequestSnapshotSchema, snapshot);
  let resolved;

  if (source.kind === "comment" || source.kind === "review") {
    const page = fromJsonString(github.PullRequestTimelinePageSchema, cached.serialized_payload);

    const entry = page.items.find(
      (item) => item.content.case === source.kind && item.content.value?.id === source.resourceId,
    )?.content.value;

    if (entry) resolved = prCommentCitation(context, entry, source.kind);
  } else if (source.kind === "review_comment" && cached.cache_kind === "pending") {
    const page = fromJsonString(github.PullRequestReviewDraftSchema, cached.serialized_payload);
    const item = page.comments.find((c) => c.comment?.id === source.resourceId);

    if (item?.comment) resolved = prCommentCitation(context, item.comment, source.kind, item);
  } else if (source.kind === "review_comment") {
    const page = fromJsonString(github.PullRequestReviewThreadsPageSchema, cached.serialized_payload);
    const thread = page.threads.find((t) => t.comments.some((c) => c.id === source.resourceId));
    const entry = thread?.comments.find((c) => c.id === source.resourceId);

    if (entry) {
      resolved = prCommentCitation(context, entry, source.kind, thread);
    }
  } else if (source.kind === "check" || source.kind === "job") {
    const check =
      source.kind === "check"
        ? fromJsonString(github.PullRequestChecksPageSchema, cached.serialized_payload, {
            ignoreUnknownFields: true,
          }).checks.find((c) => (c.nodeId || c.url || c.name) === source.resourceId)
        : fromJsonString(github.PullRequestJobsPageSchema, cached.serialized_payload).jobs.find(
            (j) => j.id === source.resourceId,
          );

    if (check && prCheckFailed(check.state))
      resolved = prCitation(context, source.kind, source.resourceId, check.name, {
        url: check.url,
        author: "provider" in check ? check.provider : "GitHub Actions",
      });
  } else {
    const log = Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(JSON.parse(cached.serialized_payload));
    const offset = log.text.indexOf(quote.text);
    resolved = prCitation(context, "log", source.resourceId, quote.text, {
      firstLine: offset < 0 ? 0 : log.text.slice(0, offset).split("\n").length,
      url: cached.source_url || `https://github.com/${cached.repository_name}/pull/${cached.number}`,
    });
  }

  if (!resolved?.pullRequest) throw missing();

  return {
    ...quote,
    sourceKind: "pull_request",
    sourceThreadId: undefined,
    sourceItemId: undefined,
    sourceAuthor: resolved.sourceAuthor,
    sourceTime: resolved.sourceTime || new Date(cached.verified_at).toISOString(),
    pullRequest: resolved.pullRequest,
  };
}
