import type { ControllerArguments, ControllerResult } from "./controller.ts";
import type { RuntimePaths } from "./runtime/config.ts";
import type { Logs } from "./runtime/log.ts";
import { loadSecrets } from "./vault.ts";
import { desktopStoragePaths } from "./storage-paths.ts";

/** Keep launch credentials on the private main/controller pipe, outside DesktopStatus and renderer IPC. */
export async function initializeController(
  directory: string,
  start: () => RuntimePaths,
  webToken: string,
  request: (action: string, args: ControllerArguments) => Promise<ControllerResult>,
  logs: Logs,
) {
  const secrets = await loadSecrets(directory);
  logs.protect(...Object.values(secrets), webToken);
  const paths = { ...start(), ...desktopStoragePaths() };
  const initialized = await request("initialize", { directory, secrets, paths, webToken });

  if (!initialized.origin || !initialized.status) throw new Error("Invalid desktop initialization response");

  return { origin: initialized.origin, status: initialized.status };
}
