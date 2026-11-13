import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import { onThisComputer } from "#lib/features/threads/thread-actions.ts";
import { provideFileLinks, type FileLinkHandler } from "#lib/shared/ui/markdown/file-links.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { openFile } from "./api.ts";
import { fileLocation } from "@canopy/domain/file-references";
import { useWorkspace, workspaceStore } from "#lib/features/workspace/workspace.svelte.ts";
import { goto } from "$app/navigation";
import type { Workspace } from "@canopy/domain/workspace";

export interface FileTarget {
  readonly threadId: string;
  readonly path: string;
  /** The file is on the computer showing it (onThisComputer): only then can its default app open it here. */
  readonly local: boolean;
  readonly itemId?: string;
}

/**
 * File paths in an agent's messages open the file: in Canopy's viewer, or (device setting "Open files in") in
 * the default app when the file is on this computer. Another machine's files always open in the viewer, never
 * in an app over there. Relative paths resolve against the thread's directory in the gateway.
 */
class ThreadFileLinks implements FileLinkHandler {
  constructor(
    readonly threadId: () => string | undefined,
    readonly local: (threadId: string) => boolean,
    readonly itemId: () => string = () => "",
    readonly workspace?: () => Workspace,
  ) {}

  open(path: string): void {
    const threadId = this.threadId();

    if (!threadId) return;
    const target = { threadId, ...fileLocation(path), local: this.local(threadId), itemId: this.itemId() };

    if (target.local && /[\\/]/.test(path) && devicePreferences.values.fileLinks === "app") void openInApp(target);
    else if (this.workspace) this.workspace().open(target);
    else {
      workspaceStore.view(threadId).open(target);
      void goto(`/threads/${encodeURIComponent(threadId)}`);
    }
  }
}

/** Makes file paths in a thread's messages clickable (call while the thread page initializes). */
export function provideThreadFileLinks(threadId: () => string | undefined, itemId?: () => string): void {
  const overview = useOverview();
  const capabilities = useGatewayCapabilities();

  const local = (id: string) => {
    const thread = overview.threads.get(id);

    return thread ? onThisComputer(thread, overview.worker(thread.workerId), capabilities?.ownGateway ?? false) : false;
  };

  provideFileLinks(new ThreadFileLinks(threadId, local, itemId, useWorkspace()));
}

/** This computer opens the file in its default app; failures show as a toast. */
export async function openInApp(target: FileTarget): Promise<boolean> {
  try {
    await openFile(target.threadId, target.path);

    return true;
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : "Could not open the file", { tone: "error" });

    return false;
  }
}
