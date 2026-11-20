import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { isWithin } from "../git/worktrees.ts";
import { CommandError } from "../runtime/host-types.ts";
import { fileChanged, type FileMutation } from "./file-mutation.ts";
import { openUnixMutation } from "./file-mutation-unix.ts";
import { openWindowsMutation } from "./file-mutation-windows.ts";

/**
 * Pins an existing regular file for a verified write or delete. `path` is the canonical path the caller already
 * authorised against `roots`; it is the only anchor and is never resolved again. It is opened component by
 * component without following any link, and the OS-reported location of the opened object must equal it exactly.
 * `writing: false` opens the file for the delete. Other platforms and any redirect, hard link or special file
 * are refused instead of falling back to a pathname.
 */
export function openFileMutation(path: string, writing: boolean, roots: readonly string[]): FileMutation {
  if (!isAbsolute(path) || !roots.some((root) => isWithin(root, path))) throw fileChanged();

  if (writing) {
    // Only chooses the error message; the open below is what decides.
    try {
      accessSync(path, constants.W_OK);
    } catch {
      throw new CommandError(
        "FILE_WRITE_FAILED",
        "Could not write this file. Check its permissions, then try again.",
        true,
      );
    }
  }

  if (process.platform === "win32") return openWindowsMutation(path, writing);

  return openUnixMutation(path, writing);
}
