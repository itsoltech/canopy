import { accessSync, constants, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";

/** Roots of the worktrees Canopy manages (docs/worktrees.md, "Położenie"). All are real paths. */
export interface WorktreeRoots {
  /** Where new worktrees go without a configured location (Hello.worktrees_root). */
  readonly primary: string;
  /** The primary root, then the legacy `<data_dir>/worktrees` when it exists: worktrees under any stay managed. */
  readonly managed: readonly string[];
}

export interface WorktreeRootsInput {
  readonly dataDir: string;
  /** CANOPY_WORKTREES_ROOT: an absolute folder that replaces the home folder (containers, servers). */
  readonly override?: string;
  /** The user's home; default HOME (USERPROFILE on Windows), else `os.homedir()`. Empty: the data directory. */
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly log?: (message: string) => void;
}

/** `<home>/canopy/worktrees` in the path syntax of the platform. */
export function homeWorktreesPath(home: string, platform: NodeJS.Platform): string {
  return (platform === "win32" ? win32 : posix).join(home, "canopy", "worktrees");
}

/** The root of worktrees made before the home folder became the default. */
export function legacyWorktreesPath(dataDir: string): string {
  return join(dataDir, "worktrees");
}

/** The folder as a writable real path (created with mode 0700), or undefined. */
function usableRoot(path: string): string | undefined {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const real = realpathSync(path);
    accessSync(real, constants.W_OK);

    return real;
  } catch {
    return undefined;
  }
}

/**
 * The managed worktree roots: CANOPY_WORKTREES_ROOT, else `~/canopy/worktrees`, else (no usable home)
 * `<data_dir>/worktrees`. A configured "Worktree location" wins over all of them per command.
 */
export function resolveWorktreeRoots(input: WorktreeRootsInput): WorktreeRoots {
  const legacy = legacyWorktreesPath(input.dataDir);
  const primary = primaryRoot(input, legacy);
  const old = existsSync(legacy) ? realpathSync(legacy) : undefined;

  return { primary, managed: old && old !== primary ? [primary, old] : [primary] };
}

function primaryRoot(input: WorktreeRootsInput, legacy: string): string {
  if (input.override) {
    if (!isAbsolute(input.override))
      throw new Error(`CANOPY_WORKTREES_ROOT must be an absolute path, got ${input.override}`);
    const root = usableRoot(input.override);

    if (!root) throw new Error(`CANOPY_WORKTREES_ROOT ${input.override} cannot be created or written`);

    return root;
  }

  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  // Read from the environment first: Bun's os.homedir() keeps the value from process start.
  const home = input.home ?? (env[platform === "win32" ? "USERPROFILE" : "HOME"] || homedir());
  const root = home ? usableRoot(homeWorktreesPath(home, platform)) : undefined;

  if (root) return root;
  const fallback = usableRoot(legacy);

  if (!fallback) throw new Error(`the worktree root ${legacy} cannot be created`);
  input.log?.(`worktrees: the home folder is not usable, new worktrees go to ${fallback}`);

  return fallback;
}
