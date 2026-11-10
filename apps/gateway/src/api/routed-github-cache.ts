import { create, fromJsonString, toJsonString, type DescMethod, type Message } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { linkedMessage } from "../computers/remote.ts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import type { LinkedComputers } from "../computers/runtime.ts";

const reads = new Set([
  "GetPullRequest",
  "ListPullRequestTimeline",
  "ListPullRequestReviewThreads",
  "ListPullRequestChecks",
  "ListPullRequestCheckJobs",
  "ListPullRequestCommits",
  "ListPullRequestFiles",
  "GetPullRequestDiff",
]);

/** GitHub access failures revoke only GitHub content; unrelated routing errors preserve verified peer reads. */
export function forgetGitHub(computers: LinkedComputers | undefined, node: string, method: DescMethod) {
  if (
    reads.has(method.name) ||
    ["WatchPullRequest", "GetPullRequestJobLog", "PreparePullRequestContext"].includes(method.name)
  )
    computers?.reads.forget(node, reads);
}

/** Bounded partner cache belongs to this owner's LinkedComputers instance; forget/unpair clears it. Logs are excluded. */
export async function offlineGitHub(computers: LinkedComputers, node: string, method: DescMethod, request: Message) {
  if (computers.reachable().includes(node)) return;

  if (method.name === "ListThreadPullRequests") {
    const id = splitId(linkedMessage(github.ThreadPullRequestsRequestSchema, request).threadId).id;
    const thread = await computers.mirror.thread(node, id);

    if (!thread) return;

    return create(github.ThreadPullRequestsResponseSchema, {
      stale: true,
      revision: thread.pullRequestRevision,
      detail: "This computer is offline. Only the latest mirrored pull request is available.",
      links: thread.newestPullRequest ? [{ summary: thread.newestPullRequest, source: "manual" }] : [],
    });
  }

  if (!reads.has(method.name)) return;

  const cached = computers.reads.read(
    node,
    method,
    request,
    async () => {
      throw new ConnectError("Connect to load this page", Code.Unavailable);
    },
    undefined,
    false,
  );

  if (!cached) throw new ConnectError("Connect to load this page", Code.Unavailable);
  const data = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(toJsonString(method.output, cached)));
  const detail = "This computer is offline. The last verified page is shown.";

  const stale =
    method.name === "GetPullRequest"
      ? { ...data, stale: true, detail }
      : {
          ...data,
          page: { ...Schema.decodeUnknownSync(Schema.JsonObject)(data["page"]), stale: true, detail },
        };

  return fromJsonString(method.output, JSON.stringify(stale));
}

export function rememberGitHub(
  computers: LinkedComputers,
  node: string,
  method: DescMethod,
  request: Message,
  message: Message,
) {
  if (reads.has(method.name)) computers.reads.remember(node, method, request, message);
}
