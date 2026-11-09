import type { RunBotTurn } from "@canopy/contracts";
import { AttachmentFiles } from "../attachments/files.ts";
import { forModel, MAX_SOURCE_BYTES, type NormalizedImage } from "../images/normalize.ts";
import { readLimited } from "../images/view-image.ts";

/** Only verified, gateway-bound images enter a bot prompt. No filesystem tool is exposed. */
export async function botImages(
  input: RunBotTurn,
  resumed: boolean,
  files: AttachmentFiles,
  fetch: (sha: string) => Promise<Uint8Array>,
): Promise<NormalizedImage[]> {
  const attachments = [...(resumed ? [] : input.historyAttachments), ...input.attachments];

  if (attachments.some((a) => a.kind !== "image" || !/^image\/(png|jpeg|gif|webp)$/.test(a.mimeType)))
    throw new Error("Unsupported bot image");
  await files.ensure(input.botId, attachments, fetch);

  return Promise.all(attachments.map((a) => forModel(readLimited(a.path, MAX_SOURCE_BYTES))));
}
