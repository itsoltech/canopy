import { create, fromJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { readThreadWatchFailure } from "@canopy/domain/thread-watch-recovery";
import {
  ui,
  AgentPreviewEventSchema,
  RunAgentToolSchema,
  type AgentPreviewEvent,
  type AgentPreviewTarget,
  type RunAgentTool,
  type AgentTool,
  type AgentPreviewInput,
} from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { encode } from "#lib/shared/wire.ts";

export type PreviewEventHandler = (event: AgentPreviewEvent) => void;

/**
 * The preview stream is a POST because the target scope is protobuf JSON rather than URL state. Keep the parser here
 * so the panel only deals with decoded events and can abort the stream when it leaves the viewport.
 */
export async function watchAgentPreview(
  request: ui.WatchAgentPreviewRequest,
  onmessage: PreviewEventHandler,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/threads/${encodeURIComponent(request.threadId)}/preview/events`, {
    method: "POST",
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(encode(ui.WatchAgentPreviewRequestSchema, request)),
    signal,
  });

  if (!response.ok) throw new Error(`Preview request failed (${response.status}).`);

  if (!response.body) throw new Error("The preview stream did not return a body.");

  await readEvents(
    response.body,
    (event) => {
      // Older gateways can ignore followAgent and stream the owner's foreground window.
      if (
        request.followAgent &&
        event.state === "frame" &&
        (event.followingAgent === event.agentObservation || (event.followingAgent && !event.targetId))
      )
        throw new ConnectError("The preview did not confirm the agent’s source.", Code.Unimplemented);

      onmessage(event);
    },
    signal,
  );
}

export async function sendAgentPreviewInput(
  threadId: string,
  previewId: string,
  inputs: readonly AgentPreviewInput[],
  signal?: AbortSignal,
): Promise<void> {
  if (!inputs.length || !previewId) return;

  const body = encode(
    ui.SendAgentPreviewInputRequestSchema,
    create(ui.SendAgentPreviewInputRequestSchema, { threadId, previewId, inputs: [...inputs] }),
  );

  await requestJson("POST", `/api/threads/${encodeURIComponent(threadId)}/preview/input`, body, 15_000, signal);
}

export async function acknowledgePreviewFrame(
  threadId: string,
  event: AgentPreviewEvent,
  signal: AbortSignal,
): Promise<void> {
  const body = encode(
    ui.AckAgentPreviewRequestSchema,
    create(ui.AckAgentPreviewRequestSchema, { threadId, previewId: event.previewId, frameId: event.frameId }),
  );

  await requestJson("POST", `/api/threads/${encodeURIComponent(threadId)}/preview/ack`, body, 10_000, signal);
}

async function readEvents(
  body: ReadableStream<Uint8Array>,
  onmessage: PreviewEventHandler,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  try {
    while (!signal.aborted) {
      const next = await reader.read();

      if (next.done) break;
      pending = (pending + decoder.decode(next.value, { stream: true })).replaceAll("\r\n", "\n");

      if (pending.length > 3 * 1024 * 1024) throw new Error("The preview frame exceeded the stream limit.");

      let boundary = pending.indexOf("\n\n");

      while (boundary >= 0) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        handleBlock(block, onmessage);
        boundary = pending.indexOf("\n\n");
      }
    }

    pending += decoder.decode();

    if (pending.trim()) handleBlock(pending, onmessage);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function handleBlock(block: string, onmessage: PreviewEventHandler): void {
  const kind = block
    .split(/\r?\n/)
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();

  if (kind === "away") throw new Error("The preview connection was interrupted.");

  if (kind === "heartbeat" || kind === "ready") return;

  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (kind === "failure")
    throw new ConnectError("The preview connection was interrupted.", readThreadWatchFailure(data).code);

  if (!data || data === "{}") return;

  onmessage(fromJsonString(AgentPreviewEventSchema, data, { ignoreUnknownFields: true }));
}

export function previewScope(tool: AgentTool, target?: AgentPreviewTarget): RunAgentTool {
  return create(RunAgentToolSchema, {
    tool,
    platform: target?.platform ?? "",
    app: target?.app ?? "",
    windowId: target?.windowId ?? "",
    deviceId: target?.deviceId ?? "",
  });
}

/** Compare the requested scope by value: refreshed labels and protobuf objects do not restart a live watch. */
export function previewScopeKey(
  threadId: string,
  workerId: string,
  tool: AgentTool,
  target?: AgentPreviewTarget,
  followAgent = false,
): string {
  return JSON.stringify([
    threadId,
    workerId,
    tool,
    followAgent,
    target?.platform ?? "",
    target?.app ?? "",
    target?.windowId ?? "",
    target?.deviceId ?? "",
  ]);
}
