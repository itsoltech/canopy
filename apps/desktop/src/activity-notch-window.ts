import { app, BrowserWindow, screen, session } from "electron";
import { join } from "node:path";
import { activityNotchGeometry, type ActivityNotchCutout } from "./activity-notch-geometry.ts";
import { activityNotchPage } from "./activity-notch-page.ts";

interface MacNotchDisplay {
  primaryCutout(): ActivityNotchCutout | undefined;
}

let macDisplay: MacNotchDisplay | null | undefined;

export function loadMacActivityNotchDisplay() {
  const directory = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build");

  // SAFETY: Both paths load the Canopy N-API addon, which exports primaryCutout with this contract.
  return require(join(directory, "native/activity-notch-display.node")) as MacNotchDisplay;
}

function primaryActivityNotchMenuBand() {
  if (process.platform !== "darwin" || macDisplay === null) return undefined;

  try {
    macDisplay ??= loadMacActivityNotchDisplay();

    return { cutout: macDisplay.primaryCutout() };
  } catch {
    // Keep the simulated shape in the work area when the camera's position is unknown.
    macDisplay = null;

    return undefined;
  }
}

export function primaryActivityNotchGeometry(expandedRows: number) {
  return activityNotchGeometry(screen.getPrimaryDisplay(), expandedRows, primaryActivityNotchMenuBand());
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
    ...primaryActivityNotchGeometry(0).bounds,
    title: "Canopy activity",
    frame: false,
    roundedCorners: false,
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
    // Electron bypasses AppKit’s visible-frame clamp for a frameless window with this option.
    ...(process.platform === "darwin" && {
      type: "panel" as const,
      acceptFirstMouse: true,
      enableLargerThanScreen: true,
    }),
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

  if (process.platform === "darwin") {
    target.excludedFromShownWindowsMenu = true;

    if (macDisplay) target.setAlwaysOnTop(true, "status");
  }

  target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  target.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  target.webContents.on("will-redirect", (event) => event.preventDefault());
  target.webContents.on("will-attach-webview", (event) => event.preventDefault());

  return { target, load: () => target.loadURL(url) };
}
