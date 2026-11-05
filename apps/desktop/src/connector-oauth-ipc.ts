import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { DesktopConnectorOAuth } from "@canopy/ui/desktop";

let pending: DesktopConnectorOAuth | undefined;

/** Keeps the latest canopy://oauth/callback return until Settings → Connectors takes it. */
export function holdConnectorOAuth(value: DesktopConnectorOAuth) {
  pending = value;
}

/** The renderer takes the return once, over the bridge; it then finishes sign-in through its gateway. */
export function registerConnectorOAuthIpc(authorize: (event: IpcMainInvokeEvent) => void) {
  ipcMain.handle("canopy:connector-oauth", (event) => {
    authorize(event);
    const value = pending;
    pending = undefined;

    return value;
  });
}
