import { app, BrowserWindow, type Session } from "electron";
import { join } from "node:path";

export function createViewerWindow(isolated: Session): BrowserWindow {
  const target = new BrowserWindow({
    width: 900,
    height: 700,
    title: "Custom HTML from the agent — Canopy",
    webPreferences: {
      session: isolated,
      preload: join(app.getAppPath(), "dist/html-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  });

  target.on("page-title-updated", (event) => event.preventDefault());
  target.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  target.webContents.on("will-navigate", (event) => event.preventDefault());
  target.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  target.webContents.on("will-redirect", (event) => event.preventDefault());
  target.webContents.on("will-attach-webview", (event) => event.preventDefault());

  return target;
}

/** This browser process owns only the viewer. Snapshot its frame PIDs before ending any of them. */
export function stopViewerFrames(target: BrowserWindow): void {
  const processes = new Set(target.webContents.mainFrame.framesInSubtree.map((frame) => frame.osProcessId));

  for (const pid of processes) {
    if (pid <= 0 || pid === process.pid) continue;

    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* The renderer can exit between enumeration and termination. */
    }
  }
}
