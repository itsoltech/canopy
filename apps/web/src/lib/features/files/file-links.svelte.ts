import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import { provideFileLinks, type FileLinkHandler } from "#lib/shared/ui/markdown/file-links.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { openFile } from "./api.ts";

export interface FileTarget {
  readonly threadId: string;
  readonly path: string;
}

/** The file open in the viewer (one at a time, app-wide: FileViewerHost in the root layout shows it). */
export const openedFile = $state<{ current?: FileTarget | undefined }>({});

/**
 * File paths in an agent's messages open the file: in Canopy's viewer, or (device setting "Open files in")
 * straight in the default app of the worker's computer. Relative paths resolve against the thread's directory
 * in the gateway.
 */
class ThreadFileLinks implements FileLinkHandler {
  constructor(readonly threadId: () => string | undefined) {}

  open(path: string): void {
    const threadId = this.threadId();

    if (!threadId) return;

    if (devicePreferences.values.fileLinks === "app") void openInApp({ threadId, path });
    else openedFile.current = { threadId, path };
  }
}

/** Makes file paths in a thread's messages clickable (call while the thread page initializes). */
export const provideThreadFileLinks = (threadId: () => string | undefined): void =>
  void provideFileLinks(new ThreadFileLinks(threadId));

/** The worker's computer opens the file in its default app; failures show as a toast. */
export async function openInApp(target: FileTarget): Promise<boolean> {
  try {
    await openFile(target.threadId, target.path);

    return true;
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : "Could not open the file", { tone: "error" });

    return false;
  }
}
