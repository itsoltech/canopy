import { BrowserWindow, Menu, session, type Tray } from "electron";
import { windowColors } from "./window-appearance.ts";
import { shutdownPage, shutdownStatus } from "./shutdown-page.ts";

export function showShutdownWindow(target: BrowserWindow | undefined) {
  if (!target || target.isDestroyed()) return;

  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

/** Independent of the revoked BFF session and the controller that is stopping. */
export function createShutdownWindow(
  iconPath: string,
  installingUpdate: boolean,
  tray: Tray | undefined,
  failed: () => void,
) {
  const colors = windowColors();
  const { title } = shutdownStatus(installingUpdate);
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(shutdownPage(installingUpdate, colors))}`;
  const isolated = session.fromPartition("canopy-shutdown");
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) =>
    callback({ cancel: details.url !== url || details.resourceType !== "mainFrame" }),
  );

  const target = new BrowserWindow({
    width: 440,
    height: 232,
    useContentSize: true,
    title,
    icon: iconPath,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: colors.canvas,
    webPreferences: {
      session: isolated,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      javascript: false,
    },
  });

  const show = () => showShutdownWindow(target);

  target.setMenu(null);
  target.on("close", (event) => event.preventDefault());
  target.once("ready-to-show", show);
  target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  target.webContents.on("will-navigate", (event) => event.preventDefault());
  target.webContents.on("will-redirect", (event) => event.preventDefault());
  target.webContents.on("will-attach-webview", (event) => event.preventDefault());
  Menu.setApplicationMenu(null);
  tray?.setToolTip(title);
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: title, enabled: false },
      { label: "Show closing status", click: show },
    ]),
  );
  void target.loadURL(url).catch(() => {
    if (!target.isDestroyed()) failed();
  });

  return target;
}
