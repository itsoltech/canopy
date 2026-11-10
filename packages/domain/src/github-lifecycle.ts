import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Schema } from "effect";

export const mergeMethodLabel = (method: string) =>
  ({ MERGE: "Merge commit", SQUASH: "Squash and merge", REBASE: "Rebase and merge" })[method] ?? method;

export const lifecycleLabel = (action: string) =>
  ({
    ready: "Ready for review",
    draft: "Convert to draft",
    merge: "Merge",
    enqueue: "Add to merge queue",
    dequeue: "Remove from queue",
    enable_auto_merge: "Enable auto-merge",
    disable_auto_merge: "Disable auto-merge",
    update_branch: "Update branch",
    close: "Close pull request",
    reopen: "Reopen pull request",
  })[action] ?? action;

export const lifecycleEffect = (action: string) =>
  ({
    ready: "GitHub notifies reviewers and may start checks.",
    draft: "GitHub marks this pull request as a draft and blocks merging.",
    merge: "GitHub merges this head into the base branch. This cannot be undone here.",
    enqueue: "GitHub queues this pull request. It merges when queue requirements pass.",
    dequeue: "GitHub removes this pull request from the merge queue.",
    enable_auto_merge: "GitHub merges this pull request automatically when its requirements pass.",
    disable_auto_merge: "GitHub stops the pending automatic merge.",
    update_branch: "GitHub updates the head branch from its base. This may start new checks.",
    close: "GitHub closes this pull request. You can reopen it later.",
    reopen: "GitHub reopens this pull request and may start checks.",
  })[action] ?? "";

export function lifecycleFields(action: string) {
  if (["ready", "draft"].includes(action)) return { action: "set_draft", draft: action === "draft" };

  if (["close", "reopen"].includes(action)) return { action: "set_open", enabled: action === "reopen" };

  if (["enqueue", "dequeue"].includes(action)) return { action: "queue", enabled: action === "enqueue" };

  if (["enable_auto_merge", "disable_auto_merge"].includes(action))
    return { action: "auto_merge", enabled: action === "enable_auto_merge" };

  return { action };
}

export const createRequest = (
  context: github.PullRequestCreateContext,
  requestId: string,
  title: string,
  body: string,
  draft: boolean,
  maintainerCanModify: boolean,
) =>
  create(github.PullRequestMutationRequestSchema, {
    threadId: context.threadId,
    repositoryName: context.repositoryName,
    headRepositoryName: context.headRepositoryName,
    headRef: context.headRef,
    baseRef: context.baseRef,
    headSha: context.headSha,
    baseSha: context.baseSha,
    accountId: context.accountId,
    accessRevision: context.accessRevision,
    action: "create_pr",
    clientRequestId: requestId,
    title,
    body,
    draft,
    maintainerCanModify,
  });

const AgentDraft = Schema.Struct({ title: Schema.String, body: Schema.String });

/** Only title and body cross this boundary. Output never selects an account, branch, or action. */
export function importPullRequestDraft(text: string) {
  const draft = Schema.decodeUnknownSync(AgentDraft)(
    JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")),
  );

  if (
    !draft.title.trim() ||
    draft.title.length > 256 ||
    draft.title.includes("\n") ||
    new TextEncoder().encode(draft.body).byteLength > 65536
  )
    throw new Error("Draft exceeds title or description limits");

  return draft;
}
