import { desktopStorageOptions } from "@canopy/logs/desktop-storage";
import type { StorageRoot } from "@canopy/logs/storage";
import type { InstallKind } from "@canopy/updater";
import type { GatewayStorageOptions } from "./storage.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Paths come only from the launch environment and the components that selected their runtime directories. */
export function gatewayStorageOptions(
  env: Env,
  runtime: {
    logs: string;
    spool: () => string;
    updates: () => string;
    web: () => string | undefined;
    kind: InstallKind;
    executable?: string;
  },
): GatewayStorageOptions {
  const directory = env["CANOPY_DESKTOP_DATA_DIR"];

  const desktop = directory
    ? desktopStorageOptions(directory, env["CANOPY_DESKTOP_APP_PATH"], env["CANOPY_DESKTOP_UPDATE_CACHE"])
    : undefined;

  const desktopRoots = desktop?.roots ?? [];

  return {
    component: desktop ? "desktop" : "gateway",
    ...(desktop?.skip && { skip: desktop.skip }),
    roots: () => {
      const web = runtime.web();

      const roots: StorageRoot[] = [
        ...desktopRoots,
        { path: runtime.logs, category: "logs" },
        { path: runtime.spool(), category: "cache" },
        { path: runtime.updates(), category: "cache" },
        ...(web ? [{ path: web, category: "cache" as const }] : []),
      ];

      // process.execPath is Bun in a source checkout; the checkout itself is project storage.
      if (!desktop && runtime.kind === "binary") {
        const executable = runtime.executable ?? process.execPath;
        roots.push(
          { path: executable, category: "application" },
          { path: `${executable}.bak`, category: "application" },
          { path: `${executable}.update.json`, category: "data" },
          { path: `${executable}.update.lock`, category: "data" },
        );
      }

      return roots;
    },
  };
}
