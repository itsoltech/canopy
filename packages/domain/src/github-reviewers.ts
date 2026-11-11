import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { mutationRequest, sendMutation, type MutationApi } from "./github-mutations.ts";

interface ReviewerApi extends MutationApi {
  getPullRequestMetadata: (r: github.PullRequestPageRequest) => Promise<github.PullRequestMetadataPage>;
}

/** Each part of a diff has its own durable receipt. Never replay a partial or uncertain diff. */
export async function applyReviewerDiff(
  api: ReviewerApi,
  snapshot: github.PullRequestSnapshot,
  before: github.PullRequestMetadata,
  ids: string[],
  uuid: () => string,
  refused: (cause: unknown) => boolean,
  detail: (cause: unknown) => string,
) {
  const old = before.reviewers.map((r) => r.id);
  const remove = old.filter((id) => !ids.includes(id));
  const add = ids.filter((id) => !old.includes(id));
  let current = before;
  let receipt = create(github.PullRequestMutationReceiptSchema, { state: "succeeded" });

  for (const [reviewerAction, metadataIds] of [
    ["remove", remove],
    ["request", add],
  ] as const) {
    if (!metadataIds.length) continue;
    receipt = await sendMutation(
      api,
      mutationRequest(snapshot, uuid(), "request_reviewers", {
        metadataRevision: current.revision,
        metadataIds,
        reviewerAction,
      }),
      refused,
      detail,
    );

    if (receipt.state !== "succeeded") return receipt;

    if (remove.length && add.length && reviewerAction === "remove") {
      const page = await api
        .getPullRequestMetadata(
          create(github.PullRequestPageRequestSchema, {
            pullRequestId: snapshot.summary?.ref?.id ?? "",
            kind: "reviewers",
            refresh: true,
          }),
        )
        .catch(() => undefined);

      if (!page?.metadata || page.page?.stale)
        return {
          ...receipt,
          state: "uncertain",
          detail: "Some reviewer requests changed. Check current state before applying again.",
        };
      current = page.metadata;
      const expected = old.filter((id) => !remove.includes(id));

      if (
        current.reviewers.length !== expected.length ||
        current.reviewers.some((r) => !expected.includes(r.id)) ||
        current.title !== before.title ||
        current.body !== before.body ||
        current.assignees
          .map((r) => r.id)
          .sort()
          .join() !==
          before.assignees
            .map((r) => r.id)
            .sort()
            .join() ||
        current.labels
          .map((r) => r.id)
          .sort()
          .join() !==
          before.labels
            .map((r) => r.id)
            .sort()
            .join()
      )
        return {
          ...receipt,
          state: "uncertain",
          detail: "These fields changed on GitHub. Check current state before applying again.",
        };
    }
  }

  return receipt;
}
