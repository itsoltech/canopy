import { MentionKind } from "@canopy/contracts";
import { formatSize, formatVideoDuration } from "@canopy/domain";
import { CHIP_CLASS, escape, iconSvg, kindLook, type MentionData } from "#lib/features/mentions/kinds.ts";
import type { DraftFile } from "./draft.svelte.ts";

/**
 * A file placed in the text (docs/ui-api.md, "Załączniki w tekście"): the composer's chip with the file's icon and
 * its name, one unit like every chip. Its upload shows on the chip itself (`data-status` on the element, set by
 * `showUploads` outside the editor's undo history): a spinner and a thin bar that fills while it uploads, red with
 * an alert icon when it failed. The icons share one slot, so a change of state never moves the text around it.
 */

/**
 * The chip's look plus the states; long names truncate (the whole name is in the tooltip). A function: kinds.ts and
 * this module import each other, so nothing here reads kinds.ts while the modules load.
 */
export const attachmentChipClass = () =>
  `${CHIP_CLASS.replace("max-w-full", "max-w-64")} group/att relative data-[status=failed]:bg-rose-600/8 data-[status=failed]:text-rose-700 dark:data-[status=failed]:bg-rose-400/12 dark:data-[status=failed]:text-rose-300`;

const GLYPH = "size-4 shrink-0 self-center";
const KIND_ICON = `${GLYPH} group-data-[status=failed]/att:hidden group-data-[status=uploading]/att:hidden`;
const FAILED_ICON = `${GLYPH} hidden group-data-[status=failed]/att:block`;

const SPINNER = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" class="${GLYPH} hidden group-data-[status=uploading]/att:block motion-safe:animate-spin"><circle cx="8" cy="8" r="6" class="stroke-current opacity-20" stroke-width="2"/><path d="M14 8a6 6 0 0 0-6-6" class="stroke-current" stroke-width="2" stroke-linecap="round"/></svg>`;

const BAR =
  "pointer-events-none absolute inset-x-1 bottom-0 hidden h-px origin-left scale-x-(--progress,0) rounded-full bg-current group-data-[status=uploading]/att:block motion-safe:transition-[scale] motion-safe:duration-(--duration-fast)";

export function attachmentChipHtml(mention: MentionData): string {
  const name = mention.label || mention.name;
  const data = escape(JSON.stringify({ ...mention, kind: mention.kind }));

  return `<span contenteditable="false" role="button" tabindex="0" aria-label="Open ${escape(name)}" data-element="mention" data-mention="${data}" data-attachment="${escape(mention.name)}" class="${attachmentChipClass()} focus-ring">${iconSvg(kindLook(mention).icon, KIND_ICON)}${SPINNER}${iconSvg("exclamation-circle", FAILED_ICON)}<span class="truncate">${escape(name)}</span><span aria-hidden="true" class="${BAR}"></span></span>`;
}

/** What a badge says on hover: the name and size, the upload's progress, or why it failed. */
export function uploadTitle(file: DraftFile): string {
  if (file.status === "failed") return `${file.name}: ${file.error ?? "Upload failed."}`;

  if (file.status === "uploading") return `${file.name} · Uploading, ${Math.round(file.progress * 100)}%`;

  return `${file.name} · ${formatSize(file.size)}`;
}

/** Each badge in `root` shows its file's upload (state, progress, tooltip). */
export function showUploads(root: ParentNode, file: (key: string) => DraftFile | undefined): void {
  for (const chip of root.querySelectorAll<HTMLElement>("[data-attachment]")) {
    const draft = file(chip.dataset["attachment"] ?? "");

    if (!draft) continue;
    chip.dataset["status"] = draft.status;
    chip.style.setProperty("--progress", String(draft.progress));
    const icon = chip.querySelector("svg");
    const kind = draft.attachment?.kind ?? (draft.video ? "video" : draft.image ? "image" : "file");

    if (icon && icon.dataset["attachmentKind"] !== kind) {
      const glyph = kindLook({ kind: MentionKind.ATTACHMENT, source: kind, isDir: false }).icon;
      icon.outerHTML = iconSvg(glyph, KIND_ICON).replace("<svg ", `<svg data-attachment-kind="${kind}" `);
    }

    let duration = chip.querySelector<HTMLElement>("[data-duration]");
    const label = formatVideoDuration(draft.attachment?.durationMs);

    if (label && !duration) {
      duration = document.createElement("span");
      duration.dataset["duration"] = "true";
      duration.className = "shrink-0 tabular-nums";
      chip.append(duration);
    }

    if (duration) duration.textContent = label ?? "";

    if (draft.status !== "ready") chip.title = uploadTitle(draft);
    else chip.removeAttribute("title");
  }
}

/** The badge of a file the composer just took (its name; an image gets the image icon). */
export const chipOf = (file: Pick<DraftFile, "key" | "name" | "image" | "video">): MentionData => ({
  kind: MentionKind.ATTACHMENT,
  name: file.key,
  label: file.name,
  path: "",
  source: file.image ? "image" : file.video ? "video" : "file",
  isDir: false,
});
