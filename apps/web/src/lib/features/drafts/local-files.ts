import type { ui } from "@canopy/contracts";
import type { DraftFile } from "#lib/features/attachments/draft.svelte.ts";

export function restoreLocalFiles(files: readonly ui.LocalComposerFile[]): DraftFile[] {
  return files.map((file) => ({
    key: file.key,
    name: file.name,
    size: Number(file.size),
    image: file.kind === "image",
    video: file.kind === "video",
    contextScope: file.contextScope || undefined,
    localUrl: undefined,
    status: file.attachment ? "ready" : "failed",
    progress: file.attachment ? 1 : 0,
    error: file.attachment ? undefined : "Upload interrupted. Remove this file and add it again.",
    attachment: file.attachment,
  }));
}
