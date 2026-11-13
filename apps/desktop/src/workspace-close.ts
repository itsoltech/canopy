import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { Schema } from "effect";

const blocked = new Set<number>();

const request = (target: BrowserWindow, action: "close" | "quit") => {
  target.show();
  target.focus();
  target.webContents.send("canopy:workspace-close", action);
};

/** Ask before stopping services. A renderer confirms only after saving or discarding its drafts. */
export function requestWorkspaceQuit(): boolean {
  const target = BrowserWindow.getAllWindows().find((target) => blocked.has(target.webContents.id));

  if (!target) return false;
  request(target, "quit");

  return true;
}

export function attachWorkspaceClose(target: BrowserWindow): void {
  const id = target.webContents.id;
  target.on("close", (event) => {
    if (!blocked.has(id)) return;
    event.preventDefault();
    request(target, "close");
  });
  target.on("closed", () => blocked.delete(id));
}

export function registerWorkspaceClose(authorize: (event: IpcMainInvokeEvent) => void): void {
  ipcMain.handle("canopy:workspace-blocked", (event, value: boolean) => {
    authorize(event);
    const isBlocked = Schema.decodeUnknownSync(Schema.Boolean)(value);

    if (isBlocked) blocked.add(event.sender.id);
    else blocked.delete(event.sender.id);
  });
  ipcMain.handle("canopy:workspace-finish-close", (event, value: "close" | "quit") => {
    authorize(event);
    const action = Schema.decodeUnknownSync(Schema.Literals(["close", "quit"]))(value);

    if (blocked.has(event.sender.id)) return;

    if (action === "quit") app.quit();
    else BrowserWindow.fromWebContents(event.sender)?.close();
  });
}
