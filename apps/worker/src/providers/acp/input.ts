import { readFile } from "node:fs/promises";
import type { UserInput } from "@canopy/contracts";
import type { Content } from "@canopy/acp";
import { interleave, isInlineImage, placedIds } from "../../attachments/inline.ts";
import { threadInstructions } from "../thread-instructions.ts";

/**
 * ACP prompt with thread instructions before the text; images as ACP image blocks
 * when the CLI declared the capability. Files placed in the text (docs/protocol.md, "Załączniki w tekście"): each
 * placed image right after its marker; a placed file stays its marker (the note names its path). Files the user did
 * not place follow the text as before: images as blocks, others as "Attachment: <path>".
 */
export async function acpPrompt(
  instructions: string,
  input: Pick<UserInput, "text" | "mentions" | "attachments">,
  images: boolean,
): Promise<Content[]> {
  const prefix = `Canopy thread instructions:\n${threadInstructions(instructions)}`;
  const prompt: Content[] = [];

  for (const part of interleave(input, (a) => images && isInlineImage(a))) {
    if (part.type === "image") prompt.push(await imageBlock(part.attachment.path, part.attachment.mimeType));
    else if (prompt.length === 0) prompt.push({ type: "text", text: [prefix, part.text].filter(Boolean).join("\n\n") });
    else if (part.text) prompt.push({ type: "text", text: part.text });
  }

  const placed = placedIds(input.mentions, input.text.length);

  for (const attachment of input.attachments) {
    if (placed.has(attachment.attachmentId)) continue;

    if (attachment.mimeType.startsWith("image/") && images)
      prompt.push(await imageBlock(attachment.path, attachment.mimeType));
    else prompt.push({ type: "text", text: `Attachment: ${attachment.path}` });
  }

  return prompt;
}

async function imageBlock(path: string, mimeType: string): Promise<Content> {
  return { type: "image", data: (await readFile(path)).toString("base64"), mimeType };
}
