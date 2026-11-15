import { isAbsolute, join, relative, sep } from "node:path";
import type { StorageRoot, StorageSamplerOptions } from "./storage.ts";
import { workerManagedStoragePath } from "./worker-storage.ts";

const DESKTOP_ENTRIES = new Set([
  "logs",
  "postgres",
  "local-worker",
  "remote-workers",
  "history-v1",
  "updates",
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Crashpad",
  "Crash Reports",
  "blob_storage",
  "Session Storage",
  "Local Storage",
  "IndexedDB",
  "Network",
  "Service Worker",
  "Dictionaries",
  "shared_proto_db",
  "WebStorage",
  "File System",
  "Sessions",
  "component_crx_cache",
  "extensions_crx_cache",
  "Preferences",
  "Secure Preferences",
  "Local State",
  "TransportSecurity",
  "Trust Tokens",
  "Trust Tokens-journal",
  "Cookies",
  "Cookies-journal",
  "Network Persistent State",
  "Reporting and NEL",
  "Reporting and NEL-journal",
  "DIPS",
  "DIPS-wal",
  "DIPS-shm",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "desktop.json",
  "secrets.enc",
  "web-port",
  "window-state.json",
  "appearance-cache.json",
  "app-updates.json",
  "app-update-checks.json",
  "app-update-history.json",
  "app-shortcuts.json",
  "remote-update.json",
]);

/** One desktop owns its installation, browser cache, database and all retained worker instances. */
export function desktopStorageOptions(
  directory: string,
  application?: string,
  updateCache?: string,
): StorageSamplerOptions & { readonly roots: readonly StorageRoot[] } {
  const roots: StorageRoot[] = [
    { path: directory, category: "data" },
    { path: join(directory, "logs"), category: "logs" },
    { path: join(directory, "postgres", "data"), category: "database" },
    { path: join(directory, "postgres", "versions"), category: "application" },
    ...["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "history-v1", "updates"].map(
      (name): StorageRoot => ({ path: join(directory, name), category: "cache" }),
    ),
    ...(application ? [{ path: application, category: "application" as const }] : []),
    ...(updateCache ? [{ path: updateCache, category: "cache" as const }] : []),
  ];

  return {
    component: "desktop",
    roots,
    skip: (path) => {
      const rest = relative(directory, path);

      if (isAbsolute(rest) || rest === ".." || rest.startsWith(".." + sep)) return false;

      const parts = rest.split(sep);
      const first = parts[0];
      const entryName = first?.replace(/\.(new|tmp)$/, "");

      // Only registered app-owned entries are traversed, even when a project is placed in userData.
      if (
        entryName &&
        entryName !== "." &&
        !DESKTOP_ENTRIES.has(entryName) &&
        !/^remote-update\.json\.[a-f0-9]{64}$/.test(entryName)
      )
        return true;

      const worker = parts[0] === "local-worker" || parts[0] === "remote-workers";

      if (!worker) return false;

      const offset = parts[0] === "local-worker" ? 1 : 2;
      const entry = parts[offset];

      if (
        entry &&
        ![
          "data",
          "worker.json",
          "worker.json.new",
          "status.json",
          "desktop-client.enc",
          "desktop-client.enc.new",
        ].includes(entry)
      )
        return true;

      const managedEntry = entry === "data" ? parts[offset + 1] : undefined;

      if (managedEntry && !workerManagedStoragePath(join(directory, ...parts.slice(0, offset + 1)), managedEntry))
        return true;

      return managedEntry === "worktrees" || (managedEntry === "bots" && parts.slice(offset + 2).includes("workspace"));
    },
  };
}
