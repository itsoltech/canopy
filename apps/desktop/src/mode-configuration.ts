import { BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron";
import { sameDesktopConfiguration, type DesktopConfiguration, type DesktopStatus } from "@canopy/ui/desktop";
import { configuration, type ConfigurationInput } from "./runtime/config.ts";
import { remoteClient } from "./client-vault.ts";
import type { DesktopClientCredential } from "./remote-client.ts";
import type { RemoteAppUpdate } from "./remote-app-update.ts";
import type { Logs } from "./runtime/log.ts";

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
export async function configureDesktopMode(
  event: IpcMainInvokeEvent,
  raw: ConfigurationInput,
  options: {
    status: DesktopStatus;
    directory: string;
    remoteUpdate: RemoteAppUpdate | undefined;
    logs: Logs;
    closeSettings: () => void;
    apply: (config: DesktopConfiguration, client: DesktopClientCredential | undefined) => Promise<void>;
  },
): Promise<boolean> {
  const { status, directory, remoteUpdate, logs } = options;
  const config = configuration(raw);
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
  const client = config.mode === "remote" ? await remoteClient(directory, config) : undefined;

  if (client) logs.protect(client.token);

  if (client) remoteUpdate?.selectDevice(client.deviceId);
  await remoteUpdate?.publish();

  if (config.mode === "remote") delete config.pairingInvitation;

  await options.apply(config, client);

  return true;
}
