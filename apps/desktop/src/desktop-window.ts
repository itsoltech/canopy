import { app, BrowserWindow, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import type { QuitGuard } from "./quit-guard.ts";
import { attachWindowChrome } from "./window-chrome.ts";

interface WindowOptions {
  productName: string;
  iconPath: string;
  quitGuard: QuitGuard;
  enrollmentReady: Set<number>;
  quitting: () => boolean;
  setupOrigin: () => string;
  webUrl: () => string | undefined;
}

export function isTrustedDesktopEvent(
  event: IpcMainInvokeEvent | IpcMainEvent,
  windows: (BrowserWindow | undefined)[],
  setupOrigin: string,
  webUrl: string | undefined,
  setupOnly = false,
) {
  const frame = event.senderFrame;

  if (
    !frame ||
    event.sender.isDestroyed() ||
    frame !== event.sender.mainFrame ||
    !windows.map((target) => target?.webContents).includes(event.sender)
  )
    return false;

  try {
    const url = new URL(frame.url);

    return setupOnly
      ? url.origin === setupOrigin && url.pathname === "/desktop"
      : url.origin === setupOrigin || url.origin === webUrl;
  } catch {
    return false;
  }
}

function external(url: string) {
  try {
    if (["https:", "http:", "mailto:"].includes(new URL(url).protocol)) void shell.openExternal(url);
  } catch {
    /* Invalid link. */
  }
}

export function createDesktopWindow(options: WindowOptions) {
  const target = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 760,
    minHeight: 560,
    title: options.productName,
    icon: options.iconPath,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000" : "#ffffff",
    ...(process.platform === "darwin" && {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 18, y: 18 },
    }),
    webPreferences: {
      preload: join(app.getAppPath(), "dist/preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  options.quitGuard.attach(target);
  attachWindowChrome(target);
  const updateBackground = () => target.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#000000" : "#ffffff");
  nativeTheme.on("updated", updateBackground);
  target.once("closed", () => nativeTheme.removeListener("updated", updateBackground));
  target.once("ready-to-show", () => {
    if (!options.quitting()) target.show();
  });
  target.on("page-title-updated", (event) => {
    event.preventDefault();
    target.setTitle(options.productName);
  });
  const contentId = target.webContents.id;
  target.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) options.enrollmentReady.delete(target.webContents.id);
  });
  target.on("closed", () => options.enrollmentReady.delete(contentId));
  target.webContents.setWindowOpenHandler(({ url }) => {
    external(url);

    return { action: "deny" };
  });
  target.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);

      if (parsed.origin === options.setupOrigin() || parsed.origin === options.webUrl()) return;
    } catch {
      /* Block malformed navigation. */
    }

    event.preventDefault();
    external(url);
  });
  target.webContents.on("will-redirect", (event, url) => {
    try {
      if ([options.setupOrigin(), options.webUrl()].includes(new URL(url).origin)) return;
    } catch {
      /* Block. */
    }

    event.preventDefault();
    external(url);
  });
  target.webContents.on("will-attach-webview", (event) => event.preventDefault());
  target.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.webContents.session.setPermissionCheckHandler(() => false);

  return target;
}
