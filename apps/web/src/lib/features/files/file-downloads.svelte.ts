import { SvelteMap } from "svelte/reactivity";
import type { DesktopFileDownload } from "@canopy/ui/desktop";
import { HttpError } from "#lib/shared/http.ts";
import { prepareFileDownload } from "./api.ts";

type DownloadState =
  | { phase: "starting" | "browser" | "requested" | "completed" | "cancelled" }
  | { phase: "progressing"; receivedBytes: number; totalBytes: number; remainingMs: number | undefined }
  | { phase: "failed"; message: string };

const START_TIMEOUT_MS = 45_000;
const RETRY = "Could not download the file. Try again.";
const pending = new Map<string, (event: DesktopFileDownload) => void>();
let unsubscribe: (() => void) | undefined;
let nextKey = 0;

export const fileDownloads = new SvelteMap<number, DownloadState & { filename: string }>();

export async function startFileDownload(threadId: string, path: string, itemId: string): Promise<void> {
  const key = ++nextKey;
  const filename = path.split(/[\\/]/).at(-1) || path;
  const desktop = window.canopyDesktop;
  const id = desktop?.onFileDownload ? crypto.randomUUID() : undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const show = (state: DownloadState) => fileDownloads.set(key, { ...state, filename });

  const finish = (state: DownloadState) => {
    clearTimeout(timeout);

    if (id) pending.delete(id);

    if (pending.size === 0) {
      unsubscribe?.();
      unsubscribe = undefined;
    }

    show(state);
    setTimeout(() => fileDownloads.delete(key), state.phase === "failed" ? 8_000 : 4_000);
  };

  show({ phase: "starting" });

  try {
    if (id && desktop?.onFileDownload) {
      pending.set(id, ({ state, receivedBytes, totalBytes, bytesPerSecond }) => {
        clearTimeout(timeout);

        if (state === "completed" || state === "cancelled") {
          finish({ phase: state });
        } else if (state === "failed") {
          finish({ phase: "failed", message: RETRY });
        } else if (receivedBytes > 0) {
          const remainingMs =
            bytesPerSecond > 0 && totalBytes > receivedBytes
              ? (1_000 * (totalBytes - receivedBytes)) / bytesPerSecond
              : undefined;

          show({ phase: state, receivedBytes, totalBytes, remainingMs });
        } else show({ phase: "starting" });
      });
      unsubscribe ??= desktop.onFileDownload((event) => pending.get(event.id)?.(event));
    }

    const href = await prepareFileDownload(threadId, path, itemId, id);

    if (id) {
      timeout = setTimeout(
        () => finish({ phase: "failed", message: "The download did not start. Try again." }),
        START_TIMEOUT_MS,
      );
    }

    // Let the browser or Electron own the transfer and pick the save location.
    const link = document.createElement("a");
    link.href = href;
    link.download = "";
    link.click();

    if (!id) finish({ phase: desktop ? "requested" : "browser" });
  } catch (cause) {
    finish({ phase: "failed", message: cause instanceof HttpError ? cause.message : RETRY });
  }
}
