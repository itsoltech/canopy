import { app, ipcMain, Notification, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { ControllerArguments, ControllerResult } from "./controller.ts";
import { RemoteAppUpdate } from "./remote-app-update.ts";
import type { DesktopUpdates } from "./updates.ts";
import type { Logs } from "./runtime/log.ts";

export function acceptRemoteUpdate(remote: RemoteAppUpdate | undefined, command: string, logs: Logs) {
  void remote?.command(fromJsonString(ui.DesktopUpdateCommandSchema, command)).catch(() => {
    logs.write("desktop", "Remote app update could not be recorded; request it again.");
  });
}

export function remoteAppUpdate(
  updates: DesktopUpdates,
  rpc: (action: string, args?: ControllerArguments) => Promise<ControllerResult>,
) {
  return new RemoteAppUpdate(join(app.getPath("userData"), "remote-update.json"), {
    status: () => updates.status(),
    check: () => updates.checkRemote(),
    drain: async (draining) => !!(await rpc("worker-drain", { draining })).idle,
    report: async (state) => {
      await rpc("remote-update-state", { updateState: toJsonString(ui.DesktopUpdateStateSchema, state) });
    },
    notify: () => {
      if (Notification.isSupported())
        new Notification({
          title: "Canopy app update requested",
          body: "Your gateway owner requested an app update. Canopy will restart after the current turns finish.",
        }).show();
    },
    restart: () => updates.restartIfReady(),
  });
}

export function registerUpdateIpc(
  updates: DesktopUpdates,
  remote: () => RemoteAppUpdate | undefined,
  authorize: (event: IpcMainInvokeEvent) => void,
) {
  ipcMain.handle("canopy:updates", (event) => {
    authorize(event);

    return updates.status();
  });
  ipcMain.handle("canopy:update-channel", (event, channel: string) => {
    authorize(event);

    if (remote()?.active) throw new Error("Wait for the remotely requested app update to finish.");

    return updates.setChannel(channel);
  });
  ipcMain.handle("canopy:update-check", (event) => {
    authorize(event);

    return updates.check();
  });
  ipcMain.handle("canopy:update-check-interval", (event, minutes: number) => {
    authorize(event);

    return updates.setCheckInterval(minutes);
  });
  ipcMain.handle("canopy:update-install", (event) => {
    authorize(event);

    if (!remote()?.active) updates.restartIfReady();
  });
}
