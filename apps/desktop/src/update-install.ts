import { mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { join, win32 } from "node:path";
import { UUID } from "builder-util-runtime";
import type { AppUpdater } from "electron-updater";
import { desktopIdentity } from "./identity.ts";

export const WINDOWS_UPDATE_ADMIN_MESSAGE =
  "This installation needs administrator approval. Choose Update manually in App updates on that computer.";

export class UpdateInstallError extends Error {}

export class UpdateInstallerMissingError extends UpdateInstallError {
  constructor() {
    super("The downloaded installer is missing. Check for updates to download it again.");
  }
}

export class WindowsManualUpdateError extends UpdateInstallError {}

export class WindowsUpdateAdminError extends WindowsManualUpdateError {
  constructor() {
    super(WINDOWS_UPDATE_ADMIN_MESSAGE);
  }
}

function registeredInstallations() {
  // Match electron-builder 26.18.0's default NSIS registry identity, shared by all channels.
  const guid: string = UUID.v5(desktopIdentity().appId, UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"));

  // Match NSIS's 64-bit registry view and preserve Unicode installation paths.
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($hive in @('LocalMachine', 'CurrentUser')) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, 'Registry64')
      $key = $base.OpenSubKey('Software\\${guid}')
      if ($null -ne $key) { [Console]::WriteLine($key.GetValue('InstallLocation', '')) }
      else { [Console]::WriteLine('') }
    }
  `;

  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });

  const [machine, user, end, extra] = (result.stdout ?? "").split(/\r?\n/);

  if (result.error || result.status !== 0 || end !== "" || extra !== undefined)
    throw new WindowsManualUpdateError("Canopy could not confirm the installation scope. Choose Update manually.");

  return { machine, user };
}

function canonicalDirectory(directory: string) {
  try {
    return win32.normalize(realpathSync.native(directory)).toLowerCase();
  } catch {
    return win32.normalize(directory).toLowerCase();
  }
}

export function checkWindowsUpdateInstall(
  directory: string,
  adminRequired: boolean,
  registry: () => { machine?: string | undefined; user?: string | undefined } = registeredInstallations,
  writable = () => rmdirSync(mkdtempSync(join(directory, ".canopy-update-"))),
) {
  if (adminRequired) throw new WindowsUpdateAdminError();
  const current = canonicalDirectory(directory);
  const { machine, user } = registry();

  if (machine && canonicalDirectory(machine) === current) throw new WindowsUpdateAdminError();

  if (!user || canonicalDirectory(user) !== current)
    throw new WindowsManualUpdateError(
      "Canopy could not confirm this is a per-user installation. Choose Update manually.",
    );

  try {
    writable();
  } catch {
    throw new WindowsUpdateAdminError();
  }
}

export async function launchWindowsUpdate(
  installer: string,
  start: (file: string, args: string[], options: SpawnOptions) => ChildProcess = spawn,
) {
  // NSIS otherwise requests elevation if it sees any machine-wide registration.
  const child = start(installer, ["--updated", "/S", "--force-run", "/currentuser"], {
    detached: true,
    stdio: "ignore",
  });

  await once(child, "spawn");
  child.unref();
}

/** Local and remote restarts reach this boundary only after the services have stopped. */
export function installAppUpdate(updater: Pick<AppUpdater, "quitAndInstall">) {
  updater.quitAndInstall(false, true);
}
