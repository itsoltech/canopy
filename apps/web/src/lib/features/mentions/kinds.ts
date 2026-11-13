import { MentionKind, type Mention } from "@canopy/contracts";
import { mentionLabel } from "@canopy/domain";
import { connectorMarks } from "#lib/features/connectors/marks.ts";
import { icons, iconStyle, type IconName } from "#lib/shared/ui/icons.ts";
import { attachmentChipHtml } from "#lib/features/attachments/inline-chip.ts";

/**
 * Inline elements of the composer (docs/ui-api.md, "Wzmianki"): how each kind looks as a chip, in the editor
 * (DOM built here, `contenteditable=false`) and in the chat (MentionText.svelte), with the same classes.
 *
 * Extension point: an inline element is `InlineElement` (a discriminated union by `type`); a new inline kind adds a
 * member and its entry in `INLINE_RENDERERS` (chip HTML + the text it stands for). Attachments are mentions too
 * (ATTACHMENT, attachments/inline-chip.ts); block-level elements of a draft (quotes) render above the text.
 */

export type InlineElement = { readonly type: "mention"; readonly mention: MentionData };

/** What a mention chip carries (Mention without its range: the range comes from where the chip sits). */
export type MentionData = Pick<Mention, "kind" | "name" | "label" | "path" | "source" | "isDir"> & {
  readonly icon?: string;
};

export interface KindLook {
  readonly icon: IconName;
  /** Group heading and the "+" menu entry. */
  readonly label: string;
}

export function kindLook(m: Pick<Mention, "kind" | "isDir" | "source">): KindLook {
  switch (m.kind) {
    case MentionKind.COMMAND:
      return { icon: "command-line", label: "Commands" };
    case MentionKind.SKILL:
      return { icon: "sparkles", label: "Skills" };
    case MentionKind.PLUGIN:
      return { icon: "square-2-stack", label: "Plugins" };
    case MentionKind.FILE:
      return m.isDir ? { icon: "folder", label: "Files" } : { icon: "document-text", label: "Files" };
    case MentionKind.THREAD:
      return { icon: "chat-bubble-left", label: "Threads" };
    case MentionKind.CONNECTOR:
      return { icon: "link", label: "Connectors" };
    case MentionKind.ATTACHMENT:
      return {
        icon: attachmentIcon(m.source),
        label: "Attachments",
      };
    default:
      return { icon: "link", label: "Mentions" };
  }
}

function attachmentIcon(source: string): IconName {
  if (source === "image") return "photo";

  if (source === "video") return "play";

  return "document-text";
}

/** The chip: accent text with the kind's icon (or the plugin's own), on a faint accent wash. */
export const CHIP_CLASS =
  "mention-chip inline-flex max-w-full items-baseline gap-1 rounded-md bg-brand-600/8 py-px pr-1.5 pl-1 align-baseline font-medium text-brand-700 select-text dark:bg-brand-400/12 dark:text-brand-300";

export const CHIP_ICON_CLASS =
  "size-4 shrink-0 self-center fill-brand-600 text-brand-600 dark:fill-brand-400 dark:text-brand-400";

export const CHIP_IMAGE_CLASS = "size-4 shrink-0 self-center rounded-sm object-contain";

export const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function iconSvg(name: IconName, className = CHIP_ICON_CLASS): string {
  const paths = icons[name].map((d) => `<path d="${d}" fill="none"/>`).join("");

  return `<svg viewBox="${iconStyle.viewBox}" fill="none" stroke="currentColor" stroke-width="${iconStyle.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${className}">${paths}</svg>`;
}

/** Only data: images and https URLs are shown (catalog icons); anything else falls back to the kind's icon. */
export function safeIcon(url: string | undefined): string | undefined {
  return url && (url.startsWith("data:image/") || url.startsWith("https://")) ? url : undefined;
}

export const INLINE_RENDERERS = {
  mention: {
    html: ({ mention }) => {
      if (mention.kind === MentionKind.ATTACHMENT) return attachmentChipHtml(mention);
      const icon = safeIcon(mention.icon);
      const mark = mention.kind === MentionKind.CONNECTOR ? connectorMarks.get(mention.source) : undefined;

      const glyph = mark
        ? `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="${CHIP_ICON_CLASS}"><path d="${mark}"/></svg>`
        : icon
          ? `<img src="${escape(icon)}" alt="" class="${CHIP_IMAGE_CLASS}">`
          : iconSvg(kindLook(mention).icon);

      const data = escape(JSON.stringify({ ...mention, kind: mention.kind }));

      return `<span contenteditable="false" data-element="mention" data-mention="${data}" class="${CHIP_CLASS}" title="${escape(chipTitle(mention))}">${glyph}<span class="truncate">${escape(mentionLabel(mention))}</span></span>`;
    },
  },
} satisfies {
  readonly [T in InlineElement["type"]]: { html(element: Extract<InlineElement, { type: T }>): string };
};

/** Hover text: what the chip stands for (a file's whole path, a command with its slash). */
export function chipTitle(m: MentionData): string {
  switch (m.kind) {
    case MentionKind.COMMAND:
      return `/${m.name}`;
    case MentionKind.FILE:
      return m.name;
    case MentionKind.THREAD:
      return `Thread: ${m.label || m.name}`;
    case MentionKind.CONNECTOR:
      return `Connector: ${m.label || m.name}`;
    case MentionKind.ATTACHMENT:
      return m.label || m.name;
    default:
      return `$${m.name}`;
  }
}
