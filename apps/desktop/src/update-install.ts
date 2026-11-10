import { mkdtempSync, rmdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { UUID } from "builder-util-runtime";
import type { AppUpdater } from "electron-updater";
import { desktopIdentity } from "./identity.ts";

export const WINDOWS_UPDATE_ADMIN_MESSAGE =
  "This installation needs administrator approval to update. Install Canopy for your user account to enable unattended updates.";

export class UpdateInstallError extends Error {}

function machineInstallation() {
  // Match electron-builder 26.18.0's default NSIS registry identity, shared by all channels.
  const guid: string = UUID.v5(desktopIdentity().appId, UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"));

  return spawnSync("reg.exe", ["query", `HKLM\\Software\\${guid}`, "/v", "InstallLocation", "/reg:64"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
}

export function checkWindowsUpdateInstall(
  directory: string,
  adminRequired: boolean,
  machineInstall: () => { status: number | null; error?: Error } = machineInstallation,
  writable = () => rmdirSync(mkdtempSync(join(directory, ".canopy-update-"))),
) {
  if (adminRequired) throw new UpdateInstallError(WINDOWS_UPDATE_ADMIN_MESSAGE);
  const result = machineInstall();

  // Assisted NSIS elevates silent updates whenever its machine-wide InstallLocation exists.
  if (result.status === 0) throw new UpdateInstallError(WINDOWS_UPDATE_ADMIN_MESSAGE);

  if (result.error || result.status !== 1)
    throw new UpdateInstallError("Could not check installation permissions. Retry the update on this computer.");

  try {
    writable();
  } catch {
    throw new UpdateInstallError(WINDOWS_UPDATE_ADMIN_MESSAGE);
  }
}

/** Local and remote restarts reach this boundary only after the services have stopped. */
export function installAppUpdate(updater: Pick<AppUpdater, "quitAndInstall">, platform = process.platform) {
  updater.quitAndInstall(platform === "win32", true);
}
