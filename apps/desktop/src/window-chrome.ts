import { BrowserWindow, ipcMain, type MenuItemConstructorOptions, type IpcMainInvokeEvent } from "electron";
import { isDesktopWindowControl, type DesktopWindowControl, type DesktopWindowState } from "@canopy/ui/desktop";

import { registerAppearanceIpc } from "./window-appearance.ts";
import { registerNotifications } from "./notifications.ts";

export function registerWindowPreferencesIpc(authorize: (event: IpcMainInvokeEvent) => void, iconPath: string): void {
  registerAppearanceIpc(authorize);
  registerNotifications(authorize, iconPath);
  ipcMain.handle("canopy:window-state", (event) => {
    authorize(event);

    return windowState(BrowserWindow.fromWebContents(event.sender)!);
  });
  ipcMain.handle("canopy:window-control", (event, control: string) => {
    authorize(event);
    const target = BrowserWindow.fromWebContents(event.sender);

    if (target && isDesktopWindowControl(control)) controlWindow(target, control);
  });
}

export function windowState(target: BrowserWindow): DesktopWindowState {
  return {
    zoomFactor: target.webContents.getZoomFactor(),
    fullscreen: target.isFullScreen(),
    maximized: target.isMaximized(),
  };
}

function sendWindowState(target: BrowserWindow) {
  if (!target.isDestroyed() && !target.webContents.isDestroyed()) {
    target.webContents.send("canopy:window-state", windowState(target));
  }
}

function sendWindowStates() {
  // Chromium shares zoom by host, so another open Canopy window may have changed too.
  for (const target of BrowserWindow.getAllWindows()) sendWindowState(target);
}

export function attachWindowChrome(target: BrowserWindow) {
  target.webContents.on("did-finish-load", () => sendWindowState(target));
  // Chromium applies gesture zoom after emitting zoom-changed.
  target.webContents.on("zoom-changed", () => setImmediate(sendWindowStates));
  target.on("focus", () => sendWindowState(target));
  target.on("enter-full-screen", () => sendWindowState(target));
  target.on("leave-full-screen", () => sendWindowState(target));
  target.on("maximize", () => sendWindowState(target));
  target.on("unmaximize", () => sendWindowState(target));
}

/** Electron's menu roles change zoom without emitting zoom-changed. Publish after menu zoom too. */
export function windowViewMenu(): MenuItemConstructorOptions {
  const zoom = (step: number | null) => {
    const target = BrowserWindow.getFocusedWindow();

    if (!target) return;
    target.webContents.setZoomLevel(step === null ? 0 : target.webContents.getZoomLevel() + step);
    sendWindowStates();
  };

  return {
    role: "viewMenu",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => zoom(null) },
      { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => zoom(0.5) },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => zoom(-0.5) },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
}

/** Windows and Linux hide the native title bar; the web UI draws these buttons in the app's style. */
export function controlWindow(target: BrowserWindow, control: DesktopWindowControl) {
  if (control === "minimize") target.minimize();
  else if (control === "close") target.close();
  else if (target.isMaximized()) target.unmaximize();
  else target.maximize();
}
