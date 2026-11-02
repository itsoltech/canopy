import { posix, win32 } from "node:path";

/**
 * Paths of a worker, interpreted by the gateway. Workers run on Linux, macOS and Windows, so a path
 * follows the worker's rules, not the gateway's. These checks are lexical; the worker remains the
 * authority on real paths (symlinks) when a thread starts.
 */
export type PathStyle = "posix" | "win32";

/** Style from the worker's `process.platform`, or from the path itself when the OS is unknown. */
export function pathStyle(os: string, sample: string): PathStyle {
  if (os === "win32") return "win32";
  if (os) return "posix";
  return /^[A-Za-z]:[\\/]|^\\\\/.test(sample) ? "win32" : "posix";
}

const lib = (style: PathStyle) => (style === "win32" ? win32 : posix);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stable names use ids only: titles never become paths or change a thread's directory. */
export function scratchBase(root: string, ownerId: string, style: PathStyle): string {
  if (!UUID.test(ownerId) || !isAbsolutePath(root, style)) throw new Error("invalid scratch root or owner id");
  return lib(style).join(normalizePath(root, style), ".open-agents", "scratch", ownerId);
}

export function scratchCwd(base: string, threadId: string, style: PathStyle): string {
  if (!UUID.test(threadId) || !isAbsolutePath(base, style)) throw new Error("invalid scratch base or thread id");
  return lib(style).join(base, threadId);
}

export function isAbsolutePath(path: string, style: PathStyle): boolean {
  return style === "win32" ? /^[A-Za-z]:[\\/]|^\\\\[^\\]/.test(path) : path.startsWith("/");
}

/** Canonical form for storage: resolved `.`/`..`, native separators, no trailing separator except at a root. */
export function normalizePath(path: string, style: PathStyle): string {
  const p = lib(style);
  const resolved = p.resolve(path);
  return resolved.length > p.parse(resolved).root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
}

/** Comparison key: Windows and macOS file systems are case-insensitive by default. */
export function pathKey(path: string, style: PathStyle, os: string): string {
  const normalized = normalizePath(path, style);
  return style === "win32" || os === "darwin" ? normalized.toLowerCase() : normalized;
}

/** Whether `path` is one of `roots` or below one. */
export function isWithinRoots(path: string, roots: readonly string[], style: PathStyle, os = ""): boolean {
  const p = lib(style);
  return roots.some((root) => {
    const relative = p.relative(pathKey(root, style, os), pathKey(path, style, os));
    return !(relative === ".." || relative.startsWith(`..${p.sep}`) || p.isAbsolute(relative));
  });
}
