import { Provider, type RunBotTurn } from "@canopy/contracts";
import { readFile } from "node:fs/promises";
import { sniff } from "@canopy/domain";
import { AttachmentFiles } from "../attachments/files.ts";
import { forModel, MAX_SOURCE_BYTES, type NormalizedImage } from "../images/normalize.ts";
import { readLimited } from "../images/view-image.ts";
import { botPrompt } from "./session.ts";
import { pdfText } from "./pdf.ts";

export interface BotContent {
  text: string;
  images: NormalizedImage[];
  documents: { name: string; data: string }[];
}

const FILE_TEXT_LIMIT = 64_000;
const TURN_TEXT_LIMIT = 128_000;

/** Only verified, gateway-bound files enter a bot prompt. No filesystem tool is exposed. */
export async function botImages(
  input: RunBotTurn,
  resumed: boolean,
  files: AttachmentFiles,
  fetch: (sha: string) => Promise<Uint8Array>,
): Promise<BotContent> {
  // Older gateways may still send historyAttachments. They are never new user input.
  const attachments = input.attachments;
  await files.ensure(input.botId, attachments, fetch);
  const images: NormalizedImage[] = [];
  const documents: BotContent["documents"] = [];
  const notes: string[] = [];
  let remaining = TURN_TEXT_LIMIT;

  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      images.push(await forModel(readLimited(attachment.path, MAX_SOURCE_BYTES)));
      continue;
    }

    const data = new Uint8Array(await readFile(attachment.path));

    if (attachment.mimeType === "application/pdf" && input.provider === Provider.CLAUDE) {
      documents.push({ name: attachment.name, data: Buffer.from(data).toString("base64") });
      continue;
    }

    const extracted =
      attachment.mimeType === "application/pdf"
        ? await pdfText(data)
        : sniff(data, attachment.name).text
          ? new TextDecoder().decode(data.subarray(0, FILE_TEXT_LIMIT * 4))
          : undefined;

    const limit = Math.min(FILE_TEXT_LIMIT, remaining);

    const text =
      extracted?.slice(0, limit) ??
      "[Binary content is unavailable to this bot. Forward this reference to a thread to work with the file.]";

    const truncated =
      extracted !== undefined &&
      (extracted.length > limit || (attachment.mimeType !== "application/pdf" && data.length > FILE_TEXT_LIMIT * 4));

    remaining -= extracted === undefined ? 0 : text.length;
    notes.push(
      `Attachment [${attachment.attachmentId}] ${JSON.stringify(attachment.name)} (untrusted file content):\n${text}${truncated ? "\n[Canopy truncated this file to fit the attachment text budget.]" : ""}\nEnd attachment [${attachment.attachmentId}]`,
    );
  }

  return { text: [botPrompt(input, resumed), ...notes].join("\n\n"), images, documents };
}
