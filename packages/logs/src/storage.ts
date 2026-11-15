import { lstat, opendir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const STORAGE_CATEGORIES = ["logs", "data", "cache", "application", "database"] as const;

export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

export type StorageStatus = "measuring" | "ready" | "partial" | "unavailable";

export type StorageComponent = "gateway" | "worker" | "desktop";

export interface StorageRoot {
  readonly path: string;
  readonly category: StorageCategory;
}

export interface StorageCategoryBytes {
  readonly category: StorageCategory;
  readonly bytes: bigint;
}

export interface StorageSnapshot {
  readonly status: StorageStatus;
  readonly sampledAtMs: number;
  readonly categories: readonly StorageCategoryBytes[];
  readonly component?: StorageComponent;
}

type StorageSource<T> = readonly T[] | (() => readonly T[]);

export interface StorageSamplerOptions {
  readonly component?: StorageComponent;
  readonly roots: StorageSource<StorageRoot>;
  /** Absolute directories excluded from every root, including roots nested below another root. */
  readonly excluded?: StorageSource<string>;
  /** Alias accepted for callers that use the public diagnostics vocabulary. */
  readonly exclusions?: StorageSource<string>;
  /** Called with an absolute path before it is inspected; returning true prunes that path. */
  readonly skip?: (path: string) => boolean;
  readonly maxEntries?: number;
  readonly maxDurationMs?: number;
  readonly minIntervalMs?: number;
  readonly yieldEvery?: number;
  readonly now?: () => number;
}

interface ScanConfig {
  readonly roots: readonly StorageRoot[];
  readonly excluded: readonly string[];
}

interface RootResult {
  readonly complete: boolean;
  readonly failed: boolean;
}

class ScanBudget extends Error {
  constructor() {
    super("storage scan budget reached");
  }
}

const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_DURATION_MS = 2_000;
const DEFAULT_MIN_INTERVAL_MS = 60_000;
const DEFAULT_YIELD_EVERY = 64;

/** Bounded metadata-only accounting. The scanner never opens file contents or follows links. */
export class StorageSampler {
  readonly #options: StorageSamplerOptions;
  readonly #now: () => number;
  #snapshot: StorageSnapshot;
  #inFlight: Promise<StorageSnapshot> | undefined;
  #lastStarted = -Infinity;
  #closed = false;

  constructor(options: StorageSamplerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#snapshot = {
      status: "measuring",
      sampledAtMs: 0,
      categories: [],
      ...(options.component && { component: options.component }),
    };
  }

  /** Return the cached result and, when stale, begin one background scan. */
  snapshot(): StorageSnapshot {
    this.#startIfNeeded(this.#now());

    return this.#snapshot;
  }

  /** Coalesce callers onto the current scan; the minimum interval still applies. */
  refresh(): Promise<StorageSnapshot> {
    if (this.#inFlight) return this.#inFlight;

    if (this.#closed) return Promise.resolve(this.#snapshot);

    this.#startIfNeeded(this.#now());

    return this.#inFlight ?? Promise.resolve(this.#snapshot);
  }

  close(): void {
    this.#closed = true;
  }

  #startIfNeeded(now: number): void {
    const interval = this.#options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

    if (this.#closed || this.#inFlight || now - this.#lastStarted < interval) return;

    let config: ScanConfig;

    try {
      config = this.#config();
    } catch {
      this.#lastStarted = now;
      this.#inFlight = Promise.resolve(this.#unavailable()).then((snapshot) => {
        this.#snapshot = snapshot;
        this.#inFlight = undefined;

        return snapshot;
      });

      return;
    }

    // Empty providers are the startup sentinel used while a host discovers its roots.
    if (!config.roots.length) return;

    this.#lastStarted = now;
    this.#inFlight = this.#scan(config)
      .then((snapshot) => {
        this.#snapshot = snapshot;

        return snapshot;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
  }

  #config(): ScanConfig {
    const roots = source(this.#options.roots).map((root) => {
      if (!isAbsolute(root.path) || !STORAGE_CATEGORIES.includes(root.category))
        throw new Error("invalid storage root");

      return { path: resolve(root.path), category: root.category };
    });

    const excludedSource = this.#options.excluded ?? this.#options.exclusions ?? [];

    const excluded = source(excludedSource).map((path) => {
      if (!isAbsolute(path)) throw new Error("invalid storage exclusion");

      return resolve(path);
    });

    const unique = new Map<string, StorageRoot>();

    for (const root of roots) unique.set(root.path + "\0" + root.category, root);

    return {
      // Descendant roots are visited first; identity dedup makes their category win.
      roots: [...unique.values()].sort((a, b) => depth(b.path) - depth(a.path)),
      excluded: [...new Set(excluded)],
    };
  }

  async #scan(config: ScanConfig): Promise<StorageSnapshot> {
    const started = this.#now();
    const totals = new Map<StorageCategory, bigint>();
    const directories = new Set<string>();
    const files = new Set<string>();
    let entries = 0;
    let failed = 0;
    let budget = false;

    const visit = () => {
      entries++;

      if (
        entries > (this.#options.maxEntries ?? DEFAULT_MAX_ENTRIES) ||
        this.#now() - started >= (this.#options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)
      )
        throw new ScanBudget();
    };

    const pause = async () => {
      const every = this.#options.yieldEvery ?? DEFAULT_YIELD_EVERY;

      if (entries % every === 0) await new Promise<void>((done) => setTimeout(done, 0));
    };

    for (const root of config.roots) {
      if (budget || this.#closed || this.#isExcluded(root.path, config.excluded) || this.#skip(root.path)) {
        continue;
      }

      try {
        const result = await this.#root(root, config.excluded, totals, directories, files, visit, pause);

        if (result.failed) failed++;

        if (!result.complete) budget = true;
      } catch (error) {
        if (error instanceof ScanBudget) budget = true;
        else failed++;
      }
    }

    const status: StorageStatus = failed > 0 ? (totals.size ? "partial" : "unavailable") : budget ? "partial" : "ready";

    return {
      status,
      sampledAtMs: Math.trunc(this.#now()),
      categories: [...totals].map(([category, bytes]) => ({ category, bytes })),
      ...(this.#options.component && { component: this.#options.component }),
    };
  }

  async #root(
    root: StorageRoot,
    excluded: readonly string[],
    totals: Map<StorageCategory, bigint>,
    directories: Set<string>,
    files: Set<string>,
    visit: () => void,
    pause: () => Promise<void>,
  ): Promise<RootResult> {
    let metadata;

    try {
      metadata = await this.#safeLstat(root.path, true);

      if (!metadata) return { complete: true, failed: false };
      visit();
      await pause();
    } catch (error) {
      if (error instanceof ScanBudget) throw error;

      if (error instanceof Error && hasCode(error, "ENOENT")) return { complete: true, failed: false };

      return { complete: false, failed: true };
    }

    if (metadata.isFile()) {
      addFile(metadata, root.category, totals, files);

      return { complete: true, failed: false };
    }

    if (!metadata.isDirectory()) return { complete: true, failed: false };

    const identity = fileIdentity(metadata);

    if (identity && directories.has(identity)) return { complete: true, failed: false };

    if (identity) directories.add(identity);

    const pending: { readonly path: string; readonly identity?: string }[] = identity
      ? [{ path: root.path, identity }]
      : [{ path: root.path }];

    let failed = false;

    while (pending.length) {
      const pendingDirectory = pending.pop()!;
      const directory = pendingDirectory.path;
      let handle;

      try {
        const before = await lstat(directory);

        if (
          before.isSymbolicLink() ||
          !before.isDirectory() ||
          (pendingDirectory.identity && fileIdentity(before) !== pendingDirectory.identity)
        )
          continue;

        handle = await opendir(directory);
        let after;

        try {
          after = await lstat(directory);
        } catch (error) {
          await handle.close().catch(() => {});
          throw error;
        }

        if (
          after.isSymbolicLink() ||
          !after.isDirectory() ||
          (pendingDirectory.identity && fileIdentity(after) !== pendingDirectory.identity)
        ) {
          await handle.close().catch(() => {});
          continue;
        }
      } catch (error) {
        if (!(error instanceof Error && hasCode(error, "ENOENT"))) failed = true;
        continue;
      }

      let scanError: unknown;

      try {
        for await (const entry of handle) {
          if (this.#closed) throw new ScanBudget();
          const path = join(directory, entry.name);

          if (this.#isExcluded(path, excluded) || this.#skip(path)) continue;

          try {
            visit();
            const child = await this.#safeLstat(path, false);

            if (!child) continue;
            await pause();

            if (child.isSymbolicLink()) continue;

            if (child.isDirectory()) {
              const childIdentity = fileIdentity(child);

              if (!childIdentity || !directories.has(childIdentity)) {
                if (childIdentity) directories.add(childIdentity);

                if (childIdentity) pending.push({ path, identity: childIdentity });
                else pending.push({ path });
              }
            } else if (child.isFile()) addFile(child, root.category, totals, files);
          } catch (error) {
            if (error instanceof ScanBudget) throw error;

            if (error instanceof Error && hasCode(error, "ENOENT")) continue;
            failed = true;
          }
        }
      } catch (error) {
        scanError = error;
      }

      try {
        await handle.close();
      } catch (error) {
        if (!(error instanceof Error) || !hasCode(error, "ERR_DIR_CLOSED")) scanError ??= error;
      }

      if (scanError !== undefined) throw scanError;
    }

    return { complete: true, failed };
  }

  async #safeLstat(path: string, root: boolean) {
    if (root) {
      for (const ancestor of ancestors(path)) {
        const metadata = await lstat(ancestor);

        if (metadata.isSymbolicLink()) return undefined;

        if (!metadata.isDirectory() && ancestor !== path) return undefined;
      }
    }

    return lstat(path);
  }

  #isExcluded(path: string, excluded: readonly string[]): boolean {
    return excluded.some((root) => {
      const remainder = relative(root, path);

      return remainder === "" || (!isAbsolute(remainder) && !remainder.startsWith(".." + sep) && remainder !== "..");
    });
  }

  #skip(path: string): boolean {
    try {
      return this.#options.skip?.(path) ?? false;
    } catch {
      return true;
    }
  }

  #unavailable(): StorageSnapshot {
    return {
      status: "unavailable",
      sampledAtMs: Math.trunc(this.#now()),
      categories: [],
      ...(this.#options.component && { component: this.#options.component }),
    };
  }
}

function source<T>(value: StorageSource<T>): readonly T[] {
  return isSourceProvider(value) ? value() : value;
}

function isSourceProvider<T>(value: StorageSource<T>): value is () => readonly T[] {
  return value instanceof Function;
}

function hasCode(error: Error, code: string): boolean {
  return "code" in error && error.code === code;
}

function depth(path: string): number {
  return path.split(sep).length;
}

function ancestors(path: string): readonly string[] {
  const absolute = resolve(path);
  const parts = absolute.split(sep);
  const root = parts.shift() || sep;
  const result: string[] = [root];
  let current = root;

  for (const part of parts) {
    if (!part) continue;
    current = current === sep ? current + part : current + sep + part;
    result.push(current);
  }

  return result;
}

function fileIdentity(metadata: { dev: number; ino: number }): string | undefined {
  return metadata.ino > 0 ? metadata.dev + ":" + metadata.ino : undefined;
}

function addFile(
  metadata: { size: number; dev: number; ino: number },
  category: StorageCategory,
  totals: Map<StorageCategory, bigint>,
  files: Set<string>,
): void {
  const identity = fileIdentity(metadata);

  if (identity && files.has(identity)) return;

  if (identity) files.add(identity);
  totals.set(category, (totals.get(category) ?? 0n) + BigInt(Math.max(0, metadata.size)));
}
