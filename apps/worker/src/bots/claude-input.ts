import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BotContent } from "./images.ts";

/** Fast input waits for the subprocess's account/model preflight; denial closes the stream without a prompt. */
export async function* claudeBotPrompt(
  content: BotContent,
  sessionId: string,
  admitted?: Promise<boolean>,
): AsyncGenerator<SDKUserMessage> {
  if (admitted && !(await admitted)) return;

  yield {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "text", text: content.text },
        ...content.documents.map((document) => ({
          type: "document" as const,
          title: document.name,
          source: { type: "base64" as const, media_type: "application/pdf" as const, data: document.data },
        })),
        ...content.images.map((image) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: image.mimeType,
            data: Buffer.from(image.data).toString("base64"),
          },
        })),
      ],
    },
  };
}
