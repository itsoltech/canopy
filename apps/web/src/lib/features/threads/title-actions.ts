import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { regenerateTitle } from "./api.ts";

/** Reusable action for the panel, command palette and future sidebar menu. */
export async function requestTitleRegeneration(threadId: string): Promise<void> {
  try {
    await regenerateTitle(threadId);
    toast("Title regeneration requested");
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : "Could not regenerate the title", { tone: "error" });
  }
}
