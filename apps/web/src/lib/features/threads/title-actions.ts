import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { regenerateTitle } from "./api.ts";

/** Reusable action for the panel, command palette and future sidebar menu. Progress shows on the title itself
 * (`Thread.titleGenerating`: shimmer in the sidebar, header and panel), so only a failure gets a toast. */
export async function requestTitleRegeneration(threadId: string): Promise<void> {
  try {
    await regenerateTitle(threadId);
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : "Could not regenerate the title", { tone: "error" });
  }
}
