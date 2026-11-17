import { browser } from "$app/env";
import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
import { onThisComputer } from "#lib/features/threads/thread-actions.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { fileLocation } from "@canopy/domain/file-references";
import { revealFile } from "./api.ts";

/** The native action is confined to this desktop's bundled worker, including after a target change. */
export function useFileReveal() {
  const overview = useOverview();
  const capabilities = useGatewayCapabilities();

  function label(threadId: string): string | undefined {
    const thread = overview.threads.get(threadId);
    const worker = thread && overview.worker(thread.workerId);

    if (
      !browser ||
      !window.canopyDesktop ||
      !thread ||
      thread.deletedAt ||
      !worker?.online ||
      !worker.fileReveal ||
      !capabilities?.localDesktop ||
      !capabilities?.methods?.includes("RevealThreadFile") ||
      !onThisComputer(thread, worker, capabilities.ownGateway)
    )
      return;

    if (worker.os === "darwin") return "Reveal in Finder";

    return worker.os === "win32" ? "Reveal in Explorer" : "Reveal in file manager";
  }

  return {
    label,
    async reveal(threadId: string, path: string, itemId = ""): Promise<void> {
      // Recheck at activation: a previously open menu must not act after switching computers.
      if (!label(threadId)) return;

      try {
        await revealFile(threadId, fileLocation(path).path, itemId);
      } catch {
        toast("Could not reveal the file. Reload the thread and try again.", { tone: "error" });
      }
    },
  };
}
