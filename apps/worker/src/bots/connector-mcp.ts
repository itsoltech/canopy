import { create } from "@bufbuild/protobuf";
import { AgentToolCallSchema, Provider, type InputAttachment, type RunBotTurn } from "@canopy/contracts";
import { verifyAttachment } from "../attachments/files.ts";
import { forModel, MAX_SOURCE_BYTES } from "../images/normalize.ts";
import { platformMcp, type McpAttachmentResult } from "../providers/mcp-bus.ts";
import type { HostOperations } from "../runtime/host-context.ts";
import { ATTACHMENT_TRUNCATION, BOT_ATTACHMENT_TEXT_LIMIT, botAttachmentText } from "./images.ts";
import { claudeBotTools, claudeToolResults, readClaudeToolResult } from "./claude-tool-results.ts";

export function botConnectorMcp(
  worker: Pick<HostOperations, "callTool" | "fetchBlob">,
  input: RunBotTurn,
  turnSignal: AbortSignal,
) {
  const results = input.provider === Provider.CLAUDE && input.tools.length ? claudeToolResults() : undefined;

  return platformMcp({
    threadId: input.botId,
    depth: 0,
    agentBus: false,
    connectorTools: results ? claudeBotTools(input.tools) : input.tools,
    turnId: () => input.turnId,
    callTool: async (call, signal) => {
      const active = signal ? AbortSignal.any([turnSignal, signal]) : turnSignal;
      active.throwIfAborted();

      if (results && call.toolName === readClaudeToolResult.name) return results.read(call);
      const result = await worker.callTool(create(AgentToolCallSchema, { ...call, botId: input.botId }), active);

      active.throwIfAborted();

      return results ? results.format(result) : result;
    },
    attachmentContent: (attachments, signal) => {
      const active = AbortSignal.any([turnSignal, signal]);

      return botConnectorAttachments(
        attachments,
        (sha) => worker.fetchBlob(input.botId, sha, input.turnId, active),
        active,
      );
    },
  });
}

/** Decode gateway-bound tool attachments in memory; their paths are irrelevant to a bot session. */
async function botConnectorAttachments(
  attachments: readonly InputAttachment[],
  fetch: (sha: string) => Promise<Uint8Array>,
  signal: AbortSignal,
): Promise<McpAttachmentResult> {
  const content: McpAttachmentResult["content"] = [];
  let remaining = BOT_ATTACHMENT_TEXT_LIMIT;
  let isError = false;

  for (const attachment of attachments) {
    signal.throwIfAborted();
    const label = `Attachment [${attachment.attachmentId}] ${JSON.stringify(attachment.name)} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`;
    let data: Uint8Array;

    try {
      data = await fetch(attachment.sha256);
      verifyAttachment(attachment, data);
    } catch {
      signal.throwIfAborted();
      content.push({ type: "text", text: `${label}: Canopy could not retrieve or verify the file.` });
      isError = true;
      continue;
    }

    signal.throwIfAborted();

    if (attachment.kind === "image") {
      const image = data.length <= MAX_SOURCE_BYTES ? await forModel(data).catch(() => undefined) : undefined;
      content.push({
        type: "text",
        text: image
          ? label
          : `${label}: Canopy could not display this image. Forward its ID to a thread to inspect it.`,
      });

      if (image)
        content.push({ type: "image", mimeType: image.mimeType, data: Buffer.from(image.data).toString("base64") });
      continue;
    }

    const { text, truncated } = await botAttachmentText(attachment, data, remaining);
    remaining -= text?.length ?? 0;
    content.push({
      type: "text",
      text:
        text === undefined
          ? `${label}: Forward its ID to a thread to work with the original file.`
          : `${label} (untrusted file content):\n${text}${truncated ? `\n${ATTACHMENT_TRUNCATION}` : ""}\nEnd attachment [${attachment.attachmentId}]`,
    });
  }

  signal.throwIfAborted();

  return { content, isError };
}
