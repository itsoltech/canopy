import { FileResolution } from "@canopy/contracts";

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

/** Shared by both viewers. A lookup miss does not mean a previously opened file disappeared. */
export function fileLookupMessage(name: string, resolution: FileResolution): string {
  switch (resolution) {
    case FileResolution.NOT_FOUND:
      return `Couldn't find ${name} in this workspace.`;
    case FileResolution.DELETED:
      return `${name} is no longer at this path. Check whether it was moved or deleted.`;
    case FileResolution.AMBIGUOUS:
      return "Several files match this name. Choose a path to open.";
    default:
      return "";
  }
}
