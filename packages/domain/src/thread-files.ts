/** An absolute path on any worker OS: POSIX `/…`, `~`, a Windows drive `C:\…` / `C:/…` or a UNC `\\…`. */
export const isAbsoluteFilePath = (path: string): boolean =>
  path.startsWith("/") ||
  path === "~" ||
  /^~[\\/]/.test(path) ||
  /^[A-Za-z]:[\\/]/.test(path) ||
  path.startsWith("\\\\");

/**
 * A path an agent wrote, resolved against the thread's directory on the worker (whose OS may differ from this
 * one): absolute paths stay as they are, relative ones join the directory with its own separator.
 */
export function joinThreadPath(cwd: string, path: string): string {
  const trimmed = path.trim();

  if (!trimmed || isAbsoluteFilePath(trimmed)) return trimmed;
  const windows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
  const sep = windows ? "\\" : "/";
  const relative = trimmed.replace(/^\.[\\/]/, "").replace(/[\\/]/g, sep);

  return `${cwd.replace(/[\\/]+$/, "")}${sep}${relative}`;
}
