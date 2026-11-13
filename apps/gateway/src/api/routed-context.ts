import { clone, type DescMessage, type DescMethod, type Message, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import { mapIds, nodesOf } from "../computers/remote.ts";
import { refuseRemoteWorktree } from "../worktrees/remote.ts";
import { PEER_READ_TIMEOUT_MS, PEER_MUTATION_TIMEOUT_MS, PEER_LONG_CALL_TIMEOUTS } from "../computers/timing.ts";

/**
 * Threads of linked computers in this gateway's API (docs/linked-computers.md, stage 2). A request whose
 * ids carry another computer's suffix goes to that computer over the link, and the answer comes back
 * with its ids qualified, so the browser and phone keep using one GatewayService. The overview, thread
 * list and model catalog add every connected computer's own. The home applies every action; this
 * gateway keeps a read-only mirror for offline reads and never queues a call for a disconnected peer.
 */
export const UNARY_TIMEOUT_MS = PEER_MUTATION_TIMEOUT_MS;

/** Calls that may outlast the usual limit at their home: a clone waits for git (docs/linked-computers.md). */
export const unaryTimeout = (method: DescMethod): number =>
  PEER_LONG_CALL_TIMEOUTS.get(method.name) ?? (READS.has(method.name) ? PEER_READ_TIMEOUT_MS : UNARY_TIMEOUT_MS);

/** Administration stays on this computer; worktree errors explain where to open the workspace. */
export function refuseForeignAdministration(method: DescMethod, request: Message): void {
  if (!nodesOf(method.input, request, true).size) return;
  refuseRemoteWorktree(method, request);
  throw new ConnectError("This isn't available for threads on another computer yet", Code.FailedPrecondition);
}

/** Calls that only read: allowed on a thread or bot frozen for a move (stage 8). */
export const READS = new Set([
  "GetGitHubRepositoryAccount",
  "ListThreadPullRequests",
  "ListRepositoryPullRequests",
  "GetPullRequest",
  "GetPullRequestAvatar",
  "GetPullRequestImage",
  "WatchPullRequest",
  "ListPullRequestTimeline",
  "ListPullRequestReviewThreads",
  "GetPullRequestReviewDraft",
  "GetPullRequestCreateContext",
  "ListPullRequestChecks",
  "ListPullRequestCheckJobs",
  "GetPullRequestJobLog",
  "ListPullRequestCommits",
  "ListPullRequestFiles",
  "GetPullRequestDiff",
  "GetOverview",
  "WatchOverview",
  "ListThreads",
  "GetThread",
  "GetThreadPanel",
  "WatchThread",
  "ListModels",
  "ListDirectory",
  "GetWorkspaceCloneSource",
  "GetWorkspaceCopyManifest",
  "WorkspaceCopySource",
  "GetAttachment",
  "GetThreadBlob",
  "GetThreadSyncContent",
  "ReadThreadFile",
  "ListThreadDirectory",
  "GetThreadFileHighlight",
  "WatchThreadFiles",
  "ListMentionCatalog",
  "SearchFiles",
  "ListGitRefs",
  "ListThreadBranches",
  "ListWorktrees",
  "ListBots",
  "ListBotApprovalRules",
  "ListThreadApprovals",
  "GetBot",
  "GetBotDraft",
  "WatchBotConversation",
  "ReadBotExchange",
  "GetBotProviderInstances",
  "ListSchedules",
  "MarkThreadSeen",
  "SetThreadRead",
  "MarkBotRead",
]);

export const PLAIN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A write on this computer's thread or bot while it moves to another computer waits, with the reason. */
export async function refuseFrozen(core: GatewayCore, method: DescMethod, request: Message) {
  const moves = core.computers?.moves;

  if (!moves || READS.has(method.name)) return;
  const ids: string[] = [];
  mapIds(method.input, request, (id) => {
    if (PLAIN.test(id)) ids.push(id);

    return id;
  });
  const reason = await moves.frozen(ids);

  if (reason) throw new ConnectError(reason, Code.FailedPrecondition);
}

/** Old ids of moved threads and bots point at their new home (stage 8). The request is rewritten in place. */
export function redirected(core: GatewayCore, method: DescMethod, request: Message): Message {
  const redirects = core.computers?.redirects;

  if (!redirects?.size) return request;
  const next = clone(method.input, request);

  return redirects.rewrite(method.input, next).length ? next : request;
}

export type Handler = {
  invoke(
    request: Message,
    context: HandlerContext,
  ): MessageInitShape<DescMessage> | Promise<MessageInitShape<DescMessage>> | AsyncIterable<Message>;
}["invoke"];

export const unary = (handler: Handler, request: Message, context: HandlerContext) =>
  // SAFETY: Called only for descriptors with methodKind unary; those handlers return a message or its promise.
  handler(request, context) as Promise<Message>;

export const stream = (handler: Handler, request: Message, context: HandlerContext) =>
  // SAFETY: Called only for server-streaming descriptors, whose handlers return an AsyncIterable.
  handler(request, context) as AsyncIterable<Message>;

export const withSignal = (context: HandlerContext, signal: AbortSignal): HandlerContext =>
  // SAFETY: Object.create preserves the complete HandlerContext prototype and overrides only its AbortSignal.
  Object.create(context, { signal: { value: signal } });

export async function single<A extends Message>(messages: AsyncIterable<Message>): Promise<A> {
  for await (const message of messages) {
    // SAFETY: Callers supply A from the output descriptor used to decode this stream.
    return message as A;
  }

  throw new ConnectError("The other computer sent no answer", Code.Internal);
}

/** The computer a routed request belongs to (its id suffix), or undefined for this computer. */
export function target(method: DescMethod, request: Message): string | undefined {
  const nodes = nodesOf(method.input, request);

  if (nodes.size > 1)
    throw new ConnectError("Choose a project, worker and thread on the same computer", Code.InvalidArgument);

  return [...nodes][0];
}
