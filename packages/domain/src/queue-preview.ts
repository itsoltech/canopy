import { MentionKind, type ui } from "@canopy/contracts";
import { mentionLabel } from "./mentions/index.ts";
import { citationTokenLabel } from "./quotes/preview.ts";

export interface QueueContentItem {
  kind: "image" | "file" | "citation";
  label: string;
}

/** Display data only: never alter the queued draft or its token ranges. */
export function queuePreview(turn: ui.Turn) {
  // Empty messageText is meaningful for content-only messages; inputText can contain the platform's file note.
  const message = turn.messageText || (turn.attachments.length || turn.quotes.length ? "" : turn.inputText);

  const tokens = [
    ...turn.mentions.map((mention) => ({
      start: mention.start,
      end: mention.end,
      label: mention.kind === MentionKind.ATTACHMENT ? " " : mentionLabel(mention),
    })),
    ...turn.quotes.flatMap((quote) =>
      quote.start === undefined || quote.end === undefined
        ? []
        : [{ start: quote.start, end: quote.end, label: citationTokenLabel(quote) }],
    ),
  ].sort((a, b) => a.start - b.start);

  let text = "";
  let at = 0;

  for (const token of tokens) {
    if (token.start < at || token.end <= token.start || token.end > message.length) continue;
    text += message.slice(at, token.start) + token.label;
    at = token.end;
  }

  text = (text + message.slice(at)).replace(/\s+/g, " ").trim();

  const items: QueueContentItem[] = [
    ...turn.attachments.map((file): QueueContentItem => ({
      kind: file.kind === "image" || file.mimeType.startsWith("image/") ? "image" : "file",
      label: file.name,
    })),
    ...turn.quotes.map((quote): QueueContentItem => ({ kind: "citation", label: citationTokenLabel(quote) })),
  ];

  const summary = (["image", "file", "citation"] as const)
    .flatMap((kind) => {
      const count = items.filter((item) => item.kind === kind).length;

      return count ? [`${count.toLocaleString("en")} ${kind}${count === 1 ? "" : "s"}`] : [];
    })
    .join(" · ");

  return { text, summary, items };
}
