import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, type Mention } from "@canopy/contracts";

/**
 * Attachments placed in the text (docs/ui-api.md, "Załączniki w tekście"): a mention of kind ATTACHMENT (name =
 * attachment id, label = file name) covers the badge's placeholder "[name]". For the agent the gateway numbers the
 * files in the order they appear (placed ones first, then the rest) and turns each placeholder into
 * "[Attachment N: name]", the same N as the note's line with the file's path.
 */

export const attachmentMarker = (n: number, name: string) => `[Attachment ${n}: ${name}]`;

/** Ids of the attachments placed in the text, in the order they appear. */
export function placedAttachmentIds(mentions: readonly Mention[]): string[] {
  return [...mentions]
    .filter((m) => m.kind === MentionKind.ATTACHMENT)
    .sort((a, b) => a.start - b.start)
    .map((m) => m.name);
}

/** The files placed in the text first, in their order there; then the rest, as they came. */
export function orderAttachments<T extends { readonly id: string }>(
  attachments: readonly T[],
  mentions: readonly Mention[],
): T[] {
  const placed = placedAttachmentIds(mentions);

  const rank = (a: T) => {
    const at = placed.indexOf(a.id);

    return at < 0 ? placed.length : at;
  };

  return attachments
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .map(({ a }) => a);
}

/**
 * The message with each placed attachment's placeholder turned into its marker ("[Attachment N: name]", N from
 * `order`: ids as the note lists them), the mentions' ranges moved along.
 */
export function numberAttachmentMarkers(message: string, mentions: readonly Mention[], order: readonly string[]) {
  let text = "";
  let at = 0;
  const placed: Mention[] = [];

  for (const m of [...mentions].sort((a, b) => a.start - b.start)) {
    text += message.slice(at, m.start);
    const n = order.indexOf(m.name) + 1;

    const marker =
      m.kind === MentionKind.ATTACHMENT && n > 0
        ? attachmentMarker(n, m.label || m.name)
        : message.slice(m.start, m.end);

    placed.push(create(MentionSchema, { ...m, start: text.length, end: text.length + marker.length }));
    text += marker;
    at = m.end;
  }

  return { message: text + message.slice(at), mentions: placed };
}
