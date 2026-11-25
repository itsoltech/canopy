import { app, BrowserWindow, screen, session } from "electron";
import { join } from "node:path";
import { activityNotchPage } from "./activity-notch-page.ts";

export function activityNotchBounds(expanded: boolean) {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(304, area.width);

  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + 8,
    width,
    height: Math.min(expanded ? 240 : 40, area.height - 8),
  };
}

export function createActivityNotchWindow() {
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(activityNotchPage())}`;
  const isolated = session.fromPartition("canopy-activity-notch");
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) =>
    callback({ cancel: details.resourceType !== "mainFrame" || details.url !== url }),
  );

  const target = new BrowserWindow({
    ...activityNotchBounds(false),
    title: "Canopy activity",
    frame: false,
    transparent: true,
    hasShadow: false,
    show: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    ...(process.platform === "darwin" && { type: "panel" as const, acceptFirstMouse: true }),
    webPreferences: {
      session: isolated,
      preload: join(app.getAppPath(), "dist/activity-notch-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  target.removeMenu();

  if (process.platform === "darwin") target.excludedFromShownWindowsMenu = true;

  target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  target.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  target.webContents.on("will-redirect", (event) => event.preventDefault());
  target.webContents.on("will-attach-webview", (event) => event.preventDefault());

  return { target, load: () => target.loadURL(url) };
}
