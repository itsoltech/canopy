import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { AppRoutes } from "./app-routes.ts";
import { windowContents } from "./window-message.ts";

export function trackAppRoutes(target: BrowserWindow, routes: AppRoutes): BrowserWindow {
  const contents = target.webContents;
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) routes.loading(contents);
  });

  return target;
}

export function showAppRoute(
  routes: AppRoutes,
  path: string,
  showMain: () => void,
  mainWindow: () => BrowserWindow | undefined,
  keyboard?: boolean,
): void {
  showMain();
  const target = mainWindow();

  if (target && !target.isDestroyed()) routes.open(target.webContents, path, keyboard);
}

export function registerAppRouteIpc(
  routes: AppRoutes,
  authorize: (event: IpcMainInvokeEvent) => void,
  mainWindow: () => BrowserWindow | undefined,
): void {
  ipcMain.handle("canopy:routes-ready", (event) => {
    authorize(event);

    if (event.sender === windowContents(mainWindow()) && new URL(event.sender.getURL()).pathname !== "/desktop")
      routes.ready(event.sender);
  });
}
