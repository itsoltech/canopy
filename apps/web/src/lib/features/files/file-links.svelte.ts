import { browser } from "$app/env";
import { FileResolution } from "@canopy/contracts";
import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import { onThisComputer } from "#lib/features/threads/thread-actions.ts";
import { provideFileLinks, type FileLinkHandler } from "#lib/shared/ui/markdown/file-links.ts";
import { copyText } from "#lib/shared/clipboard.ts";
import { HttpError } from "#lib/shared/http.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { openFile, readFile } from "./api.ts";
import { startFileDownload } from "./file-downloads.svelte.ts";
import { fileLocation } from "@canopy/domain/file-references";
import { useWorkspace, workspaceStore } from "#lib/features/workspace/workspace.svelte.ts";
import { goto } from "$app/navigation";
import type { Workspace } from "@canopy/domain/workspace";
import { useFileReveal } from "./file-reveal.svelte.ts";

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
    readonly native?: ReturnType<typeof useFileReveal>,
  ) {}

  get revealLabel(): string | undefined {
    const threadId = this.threadId();

    return threadId ? this.native?.label(threadId) : undefined;
  }

  get canDownload(): boolean {
    const threadId = this.threadId();

    return !!threadId && !this.local(threadId);
  }

  reveal(path: string): void {
    const threadId = this.threadId();

    if (threadId) void this.native?.reveal(threadId, path, this.itemId());
  }

  open(path: string): void {
    const threadId = this.threadId();

    if (!threadId) return;
    const target = { threadId, ...fileLocation(path), local: this.local(threadId), itemId: this.itemId() };

    if (target.local && /[\\/]/.test(path) && devicePreferences.values.fileLinks === "app")
      void openInApp(target, () => this.#preview(target));
    else this.#preview(target);
  }

  copyPath(path: string, kind: "full" | "relative"): void {
    const threadId = this.threadId();

    if (threadId) void copyText(this.#resolvePath(threadId, fileLocation(path).path, kind));
  }

  async #resolvePath(threadId: string, path: string, kind: "full" | "relative"): Promise<string> {
    const file = await readFile(threadId, path, this.itemId()).catch((cause: unknown) => {
      if (cause instanceof HttpError) throw cause;
      throw new Error("Could not load the file path. Try again.");
    });

    if (file.resolution === FileResolution.AMBIGUOUS)
      throw new Error("Several files match this name. Open the link to choose a path.");

    if (!file.path) throw new Error("Could not find this file. Check its path, then try again.");

    if (kind === "full") return file.path;

    if (file.relativePath) return file.relativePath;

    throw new Error("No relative path is available. Use Copy full path.");
  }

  download(path: string): void {
    const threadId = this.threadId();

    if (!threadId || this.local(threadId)) return;

    void startFileDownload(threadId, fileLocation(path).path, this.itemId());
  }

  #preview(target: FileTarget): void {
    if (this.workspace) this.workspace().open(target);
    else {
      workspaceStore.view(target.threadId).open(target);
      void goto(`/threads/${encodeURIComponent(target.threadId)}`);
    }
  }
}

/** Makes file paths in a thread's messages clickable (call while the thread page initializes). */
export function provideThreadFileLinks(threadId: () => string | undefined, itemId?: () => string): void {
  const overview = useOverview();
  const capabilities = useGatewayCapabilities();

  const local = (id: string) => {
    const thread = overview.threads.get(id);

    return !!(
      browser &&
      window.canopyDesktop &&
      capabilities?.localDesktop &&
      thread &&
      onThisComputer(thread, overview.worker(thread.workerId), capabilities.ownGateway)
    );
  };

  provideFileLinks(new ThreadFileLinks(threadId, local, itemId, useWorkspace(), useFileReveal()));
}

/** This computer opens the file in its default app; failures show as a toast. */
export async function openInApp(target: FileTarget, fallback?: () => void): Promise<boolean> {
  try {
    await openFile(target.threadId, target.path);

    return true;
  } catch (cause) {
    if (fallback) fallback();
    else toast(cause instanceof Error ? cause.message : "Could not open the file", { tone: "error" });

    return false;
  }
}
