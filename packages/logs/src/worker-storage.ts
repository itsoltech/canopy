import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StorageCategory, StorageRoot, StorageSamplerOptions } from "./storage.ts";

/** Top-level worker data entries owned by Canopy. Unknown entries are never included by the worker sampler. */
export const WORKER_MANAGED_ENTRIES = [
  "agent-environment",
  "agent-tools",
  "attachments",
  "bots",
  "claude-home",
  "cli-install",
  "codex-home",
  "diagnostics-log-spool",
  "grok",
  "grok-home",
  "homes",
  "import",
  "journal.db",
  "journal.db-shm",
  "journal.db-wal",
  "logs",
  "previews",
  "text-generation",
  "thread-secrets",
  "workspace-copies",
  "worktree-removals",
  "worktrees",
] as const;

type WorkerManagedEntry = (typeof WORKER_MANAGED_ENTRIES)[number];

/** Resolve one direct, allowlisted worker entry. Unknown or nested names return undefined. */
export function workerManagedStoragePath(dataDir: string, entry: string): string | undefined {
  if (!WORKER_MANAGED_ENTRIES.some((value) => value === entry) || entry.includes("/") || entry.includes("\\"))
    return undefined;

  return join(resolve(dataDir), entry);
}

export interface WorkerStorageOptions {
  readonly dataDir: string;
  readonly logDirectory?: string;
  readonly worktreeRoots?: readonly string[];
  readonly externalProviderHomes?: readonly string[];
  readonly additionalRoots?: readonly StorageRoot[];
}

/** Roots and pruning rules for the worker's own Canopy-managed files. */
export function workerStorageOptions(options: WorkerStorageOptions): StorageSamplerOptions {
  const dataDir = resolve(options.dataDir);

  const root = (entry: WorkerManagedEntry, category: StorageCategory): StorageRoot => ({
    path: workerManagedStoragePath(dataDir, entry)!,
    category,
  });

  const roots: StorageRoot[] = [{ path: dataDir, category: "data" }];

  if (options.logDirectory) roots.push({ path: resolve(options.logDirectory), category: "logs" });

  for (const entry of ["journal.db", "journal.db-shm", "journal.db-wal"] as const) roots.push(root(entry, "database"));

  for (const entry of ["agent-tools", "cli-install"] as const) roots.push(root(entry, "application"));

  for (const entry of ["diagnostics-log-spool", "previews"] as const) roots.push(root(entry, "cache"));
  roots.push(...(options.additionalRoots ?? []));

  const excluded = [
    join(dataDir, "scratch"),
    ...(options.worktreeRoots ?? []).map((path) => resolve(path)),
    ...(options.externalProviderHomes ?? []).map((path) => resolve(path)),
  ];

  const managed = new Set<string>(WORKER_MANAGED_ENTRIES);

  return {
    component: "worker",
    roots,
    excluded,
    skip: (path) => {
      const rest = relative(dataDir, path);

      if (isAbsolute(rest) || rest.startsWith(".." + sep) || rest === "..") return false;
      const parts = rest === "." ? [] : rest.split(sep);
      const [entry] = parts;

      if (entry === "scratch" || entry === "worktrees") return true;

      if (!entry || managed.has(entry)) {
        if (entry === "bots" && parts.includes("workspace")) return true;

        return false;
      }

      return true;
    },
  };
}
