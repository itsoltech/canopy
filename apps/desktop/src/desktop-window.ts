import { app, BrowserWindow, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import type { QuitGuard } from "./quit-guard.ts";
import { attachWindowChrome } from "./window-chrome.ts";
import { applyWindowAppearance, windowAppearance, windowColors } from "./window-appearance.ts";
import { trackAppRoutes } from "./app-route-ipc.ts";
import type { AppRoutes } from "./app-routes.ts";
import type { WindowPlacement } from "./window-state.ts";
import { allowedPermission } from "./window-permissions.ts";

interface WindowOptions {
  appRoutes: AppRoutes;
  productName: string;
  iconPath: string;
  quitGuard: QuitGuard;
  enrollmentReady: Set<number>;
  quitting: () => boolean;
  setupOrigin: () => string;
  webUrl: () => string | undefined;
  /** Saved position and size; only the main window remembers them. */
  placement?: WindowPlacement | undefined;
}

export const windowSizeLimits = { minWidth: 760, minHeight: 560 };

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
  nativeTheme.themeSource = windowAppearance().scheme;

  const target = new BrowserWindow({
    width: 1280,
    height: 850,
    ...options.placement?.bounds,
    ...windowSizeLimits,
    title: options.productName,
    icon: options.iconPath,
    show: false,
    backgroundColor: windowColors()["canvas"],
    ...((process.platform === "win32" || process.platform === "linux") && {
      titleBarStyle: "hidden" as const,
      titleBarOverlay: { color: windowColors().canvas, symbolColor: windowColors().ink, height: 48 },
    }),
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
  trackAppRoutes(target, options.appRoutes);
  attachWindowChrome(target);
  options.placement?.track(target);
  const updateBackground = () => applyWindowAppearance(target);
  nativeTheme.on("updated", updateBackground);
  target.once("closed", () => nativeTheme.removeListener("updated", updateBackground));
  target.once("ready-to-show", () => {
    if (options.quitting()) return;

    target.show();
    options.placement?.restore(target);
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
  const trusted = () => [options.setupOrigin(), options.webUrl()];
  target.webContents.session.setPermissionRequestHandler((_webContents, permission, callback, details) =>
    callback(allowedPermission(permission, details.requestingUrl, trusted())),
  );
  target.webContents.session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    allowedPermission(permission, requestingOrigin, trusted()),
  );

  return target;
}
