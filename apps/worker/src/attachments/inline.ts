import { MentionKind, type InputAttachment, type Mention, type UserInput } from "@canopy/contracts";

/**
 * A message with files placed in its text (docs/protocol.md, "Załączniki w tekście"): ATTACHMENT mentions cover
 * the markers "[Attachment N: name]" the gateway wrote, `name` = the attachment's id. A harness that takes ordered
 * mixed content gets the text split after each placed image's marker, the image right there; other files stay
 * markers (the platform note lists each one's path under the same number).
 */

export type InlinePart =
  | {
      readonly type: "text";
      readonly text: string;
      /** Where the part starts in the whole text (UTF-16), for ranges inside it. */
      readonly offset: number;
    }
  | { readonly type: "image"; readonly attachment: InputAttachment };

/** Images a model sees inline: what the gateway keeps as images (uploads are PNG, JPEG, WebP or GIF). */
export const isInlineImage = (a: InputAttachment) =>
  a.kind === "image" && /^image\/(png|jpeg|webp|gif)$/.test(a.mimeType);

/**
 * The input's text and its placed images in the user's order. `inline` picks the files that go as content (the
 * harness's image support); without any, one text part (the input as it always went).
 */
export function interleave(
  input: Pick<UserInput, "text" | "mentions" | "attachments">,
  inline: (attachment: InputAttachment) => boolean = isInlineImage,
): InlinePart[] {
  const byId = new Map(input.attachments.map((a) => [a.attachmentId, a]));
  const parts: InlinePart[] = [];
  let at = 0;

  for (const m of placed(input.mentions, input.text.length)) {
    const attachment = byId.get(m.name);

    if (!attachment || !inline(attachment)) continue;

    if (m.end > at) parts.push({ type: "text", text: input.text.slice(at, m.end), offset: at });
    parts.push({ type: "image", attachment });
    at = m.end;
  }

  if (at < input.text.length || parts.length === 0)
    parts.push({ type: "text", text: input.text.slice(at), offset: at });

  return parts;
}

/** The ids of the files placed in the text (each once), in their order. */
export function placedIds(mentions: readonly Mention[], length: number): Set<string> {
  return new Set(placed(mentions, length).map((m) => m.name));
}

function placed(mentions: readonly Mention[], length: number): Mention[] {
  return mentions
    .filter((m) => m.kind === MentionKind.ATTACHMENT && m.end > m.start && m.end <= length)
    .sort((a, b) => a.start - b.start);
}
