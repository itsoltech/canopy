import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UserInput } from "@canopy/contracts";
import { interleave } from "../../attachments/inline.ts";
import { forModel, MAX_SOURCE_BYTES } from "../../images/normalize.ts";
import { readLimited } from "../../images/view-image.ts";

type Content = SDKUserMessage["message"]["content"];

type Block = Exclude<Content, string>[number];

/**
 * Claude's user content (docs/claude-adapter.md, "Załączniki w tekście"): the text as is, or, with images placed in
 * it, text blocks with an image block right after each placed image's marker (scaled like view_image so any model
 * takes it). An image that cannot be read or scaled stays its marker: the note names its path, Read opens it.
 */
export async function claudeContent(input: Pick<UserInput, "text" | "mentions" | "attachments">): Promise<Content> {
  const parts = interleave(input);

  if (parts.length === 1 && parts[0]!.type === "text") return input.text;
  const blocks: Block[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
      continue;
    }

    try {
      const image = await forModel(readLimited(part.attachment.path, MAX_SOURCE_BYTES));
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: image.mimeType, data: Buffer.from(image.data).toString("base64") },
      });
    } catch {
      // The marker and the note stay: the agent can still Read the file.
    }
  }

  return blocks;
}
