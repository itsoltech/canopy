import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { DesktopHistoryCache } from "./history-cache.ts";

export const desktopHistory = () => new DesktopHistoryCache(join(app.getPath("userData"), "history-v1"));

export function registerHistoryIpc(
  cache: DesktopHistoryCache,
  authorize: (event: IpcMainInvokeEvent) => void,
  available: () => boolean,
) {
  const check = (event: IpcMainInvokeEvent) => {
    authorize(event);

    if (!available()) throw new Error("History unavailable");
  };

  ipcMain.handle("canopy:history-read", (event, key: string) => {
    check(event);

    return cache.read(key);
  });
  ipcMain.handle("canopy:history-write", (event, generation: string, key: string, bytes: Uint8Array) => {
    check(event);

    return cache.write(generation, key, bytes);
  });
  ipcMain.handle("canopy:history-remove", (event, key: string) => {
    check(event);

    return cache.remove(key);
  });
  ipcMain.handle("canopy:history-reconcile-bots", (event, generation: string, ids: string[]) => {
    check(event);

    return cache.reconcileBots(generation, ids);
  });
  ipcMain.handle("canopy:history-clear", (event) => {
    authorize(event);

    return cache.clear();
  });
}
