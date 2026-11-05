import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { AppRoutes } from "./app-routes.ts";

export function trackAppRoutes(target: BrowserWindow, routes: AppRoutes): BrowserWindow {
  target.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) routes.loading(target.webContents);
  });

  return target;
}

export function showAppRoute(
  routes: AppRoutes,
  path: string,
  showMain: () => void,
  mainWindow: () => BrowserWindow | undefined,
): void {
  showMain();
  const target = mainWindow();

  if (target && !target.isDestroyed()) routes.open(target.webContents, path);
}

export function registerAppRouteIpc(
  routes: AppRoutes,
  authorize: (event: IpcMainInvokeEvent) => void,
  mainWindow: () => BrowserWindow | undefined,
): void {
  ipcMain.handle("canopy:routes-ready", (event) => {
    authorize(event);

    if (event.sender === mainWindow()?.webContents && new URL(event.sender.getURL()).pathname !== "/desktop")
      routes.ready(event.sender);
  });
}
