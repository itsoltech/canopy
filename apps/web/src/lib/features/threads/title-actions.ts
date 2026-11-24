import type { ui } from "@canopy/contracts";
import { supportsIsolatedRuns } from "@canopy/domain/harnesses";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { regenerateTitle } from "./api.ts";

export const canGenerateTitle = (thread: ui.Thread, settings: ui.TextGenerationSettings): boolean =>
  supportsIsolatedRuns(settings.model ? settings.provider : thread.provider);

/** Reusable action for the panel, command palette and future sidebar menu. Progress shows on the title itself
 * (`Thread.titleGenerating`: shimmer in the sidebar, header and panel), so only a failure gets a toast. */
export async function requestTitleRegeneration(threadId: string): Promise<void> {
  try {
    await regenerateTitle(threadId);
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : "Could not regenerate the title", { tone: "error" });
  }
}
