import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { sameDesktopConfiguration, type DesktopConfiguration, type DesktopStatus } from "@canopy/ui/desktop";
import { configuration, type ConfigurationInput } from "./runtime/config.ts";
import { configureRemoteClient } from "./client-vault.ts";
import type { DesktopClientCredential } from "./remote-client.ts";
import type { RemoteAppUpdate } from "./remote-app-update.ts";
import type { Logs } from "./runtime/log.ts";
import type { ControllerResult } from "./controller.ts";

interface ModeOptions {
  status: DesktopStatus;
  directory: string;
  remoteUpdate: RemoteAppUpdate | undefined;
  logs: Logs;
  closeSettings: () => void;
  apply: (config: DesktopConfiguration, client: DesktopClientCredential | undefined) => Promise<void>;
}

export function registerModeIpc(
  authorize: (event: IpcMainInvokeEvent) => void,
  lock: () => () => void,
  readMigration: () => Promise<ControllerResult>,
  options: () => ModeOptions,
) {
  ipcMain.handle("canopy:configure", async (event, raw: ConfigurationInput) => {
    authorize(event);
    const release = lock();

    try {
      const current = await readMigration();

      if (current.migrationRunId && current.migration?.phase !== "completed")
        throw new Error("Finish the gateway migration before changing desktop mode");

      return await configureDesktopMode(event, raw, options());
    } finally {
      release();
    }
  });
  ipcMain.handle("canopy:close-settings", (event) => {
    authorize(event);
    options().closeSettings();
  });
}

export function openModeChooser(options: {
  current: BrowserWindow | undefined;
  create: () => BrowserWindow;
  origin: string;
  closed: () => void;
}) {
  if (options.current && !options.current.isDestroyed()) {
    options.current.show();
    options.current.focus();

    return options.current;
  }

  const chooser = options.create();
  chooser.on("closed", options.closed);
  void chooser.loadURL(`${options.origin}/desktop?settings=1`);

  return chooser;
}

export function closeModeChooser(chooser: BrowserWindow | undefined, application: BrowserWindow | undefined) {
  chooser?.close();

  if (application && !application.isDestroyed()) {
    application.show();
    application.focus();
  }
}

/** Called only after main has authorized the local setup frame and acquired its configuration lock. */
async function configureDesktopMode(
  event: IpcMainInvokeEvent,
  raw: ConfigurationInput,
  options: ModeOptions,
): Promise<boolean> {
  const { status, directory, remoteUpdate, logs } = options;
  const config = configuration(raw, status.configuration);

  const savedAddress = status.configuration?.mode === "remote" ? status.configuration.gatewayUrl : status.gatewayUrl;

  if (
    config.mode === "remote" &&
    config.gatewayUrl !== savedAddress &&
    !config.enrollmentToken &&
    new URL(config.gatewayUrl).protocol !== "https:"
  )
    throw new Error("Use an HTTPS address from Network access.");

  const unchanged = sameDesktopConfiguration(config, status.configuration);
  const choosingMode = new URL(event.sender.getURL()).searchParams.get("settings") === "1";

  // Startup recovery may retry the saved selection; saving the mode chooser must never restart it.
  if (unchanged && (choosingMode || status.phase === "running")) {
    options.closeSettings();

    return true;
  }

  if (remoteUpdate?.active) throw new Error("Wait for the requested app update to finish.");

  if (status.configuration && !unchanged) {
    const parent = BrowserWindow.fromWebContents(event.sender);

    if (!parent) throw new Error("Desktop settings window is unavailable");

    const confirmation = await dialog.showMessageBox(parent, {
      type: "warning",
      message: "Change desktop mode settings?",
      detail: "Saving restarts this computer’s services and stops its running agents.",
      buttons: ["Cancel", "Save and restart"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });

    if (confirmation.response !== 1) return false;
  }

  if (config.mode === "remote" && config.enrollmentToken) logs.protect(config.enrollmentToken);
  const remote = config.mode === "remote" ? await configureRemoteClient(directory, config) : undefined;
  const client = remote?.client;

  if (client) logs.protect(client.token);

  if (client) remoteUpdate?.selectDevice(client.deviceId);
  await remoteUpdate?.publish();

  if (remote) delete remote.config.pairingInvitation;

  await options.apply(remote?.config ?? config, client);

  return true;
}
