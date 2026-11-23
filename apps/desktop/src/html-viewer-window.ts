import { app, BrowserWindow, type Session } from "electron";
import { join } from "node:path";
import { desktopResourcePaths } from "./desktop-resources.ts";

export function createViewerWindow(isolated: Session, inline?: { width: number; height: number }): BrowserWindow {
  const target = new BrowserWindow({
    width: inline?.width ?? 900,
    height: inline?.height ?? 700,
    useContentSize: true,
    show: !inline,
    title: "Custom HTML from the agent — Canopy",
    icon: desktopResourcePaths().iconPath,
    webPreferences: {
      session: isolated,
      preload: join(app.getAppPath(), "dist/html-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      offscreen: Boolean(inline),
      // Hidden viewers must keep heartbeats alive; the main-process watchdog is independent.
      backgroundThrottling: false,
    },
  });

  // Hidden offscreen windows can initialize at 1×1 before their native bounds are applied.
  if (inline) target.setContentSize(inline.width, inline.height);
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
