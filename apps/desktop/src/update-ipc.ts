import { app, ipcMain, Notification, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { ControllerArguments, ControllerResult } from "./controller.ts";
import { RemoteAppUpdate } from "./remote-app-update.ts";
import type { DesktopUpdates } from "./updates.ts";
import type { Logs } from "./runtime/log.ts";

export function acceptRemoteUpdate(
  remote: RemoteAppUpdate | undefined,
  updates: DesktopUpdates,
  json: string,
  logs: Logs,
) {
  const command = fromJsonString(ui.DesktopUpdateCommandSchema, json);

  // A linked computer's "Check now": this app's own check, channel and settings; it installs nothing.
  if (command.check) {
    if (!remote?.active) void updates.check().catch(() => {});

    return;
  }

  void remote?.command(command).catch(() => {
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
    notify: (requestedBy) => {
      if (Notification.isSupported())
        new Notification({
          title: "Canopy app update requested",
          body: requestedBy
            ? `${requestedBy} requested an app update. Canopy restarts after the current turns end.`
            : "Your gateway owner requested an app update. Canopy will restart after the current turns finish.",
        }).show();
    },
    prepareRestart: () => updates.prepareRestart(),
    restart: () => updates.restartPrepared(),
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

    return remote()?.active ? undefined : updates.restartIfReady();
  });
}
