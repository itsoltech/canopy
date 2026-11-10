import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { copySafePath } from "@canopy/domain/workspace-copy";
import { CommandError } from "../runtime/host-types.ts";

export const copyError = (message: string) => new CommandError("WORKSPACE_COPY_FAILED", message, true);

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);

  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}

export function checkedPath(root: string, path: string): string {
  if (!copySafePath(path)) throw copyError("This repository contains a path that cannot be copied safely.");
  const full = resolve(root, path);

  if (!within(root, full)) throw copyError("A file points outside the repository.");

  return full;
}

/** Never follow a symlink in an ancestor, even if the source changes after the preview. */
export async function checkedParent(root: string, full: string): Promise<void> {
  if ((await realpath(dirname(full))) !== dirname(full) || !within(root, full))
    throw copyError("A file path changed after the preview. Refresh the file list.");
}

export async function readHandle(root: string, path: string) {
  const full = checkedPath(root, path);
  await checkedParent(root, full);
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = await handle.stat();

  if (!info.isFile()) {
    await handle.close();
    throw copyError("Only regular files can be copied.");
  }

  return { handle, info };
}

export async function sameIdentity(path: string, dev: number, ino: number) {
  const stat = await lstat(path).catch(() => undefined);

  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink() && stat.dev === dev && stat.ino === ino);
}
