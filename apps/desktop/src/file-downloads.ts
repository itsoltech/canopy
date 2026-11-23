import type { DownloadItem, WebContents, WebFrameMain } from "electron";
import type { DesktopFileDownload } from "@canopy/ui/desktop";
import { sendWebContentsMessage } from "./window-message.ts";

const FILE_DOWNLOAD_PATH = /^\/api\/threads\/[^/]+\/files\/download$/;
const DOWNLOAD_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;

/** Observe the native save without changing the destination prompt or handling file data in the renderer. */
export function trackFileDownloads(contents: WebContents, webOrigin: () => string | undefined): void {
  const session = contents.session;

  function track(_event: Electron.Event, item: DownloadItem, source: WebContents, frame: WebFrameMain | null) {
    if (source !== contents || contents.isDestroyed() || frame !== contents.mainFrame) return;
    const url = URL.parse(item.getURL());

    if (!url || url.origin !== webOrigin() || !FILE_DOWNLOAD_PATH.test(url.pathname)) return;
    const id = url.searchParams.get("downloadId");

    if (!id || !DOWNLOAD_ID.test(id)) return;
    const origin = url.origin;

    const send = (state: DesktopFileDownload["state"]) => {
      sendWebContentsMessage(contents, (target) => {
        if (origin !== webOrigin() || URL.parse(target.getURL())?.origin !== origin) return;

        const progress: DesktopFileDownload = {
          id,
          state,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          bytesPerSecond: state === "progressing" ? item.getCurrentBytesPerSecond() : 0,
        };

        target.send("canopy:file-download", progress);
      });
    };

    let interrupted = false;
    item.on("updated", (_update, state) => {
      if (state === "progressing") {
        send(state);
      } else {
        // Close the interrupted item so a new click can start a fresh download.
        interrupted = true;
        item.cancel();
      }
    });
    item.once("done", (_done, state) => send(interrupted || state === "interrupted" ? "failed" : state));
    send("progressing");
  }

  session.on("will-download", track);
  contents.once("destroyed", () => session.off("will-download", track));
}
