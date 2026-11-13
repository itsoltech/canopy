import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { isWithin } from "../git/worktrees.ts";
import { CommandError } from "../runtime/host-types.ts";

export const directoryRefused = () =>
  new CommandError(
    "DIRECTORY_PATH_INVALID",
    "Use a directory inside this thread's working directory, then reload.",
    true,
  );

export const directoryIdentity = (value: string) => createHash("sha256").update(value).digest("hex");

export async function directoryRevision(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });

  return directoryIdentity(`${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`);
}

/** Only the gateway supplies workspace. Directory components never follow a symlink. */
export async function directoryPath(workspace: string, directory: string) {
  if (
    !isAbsolute(workspace) ||
    directory.length > 4096 ||
    directory.includes("\0") ||
    directory.includes("\\") ||
    isAbsolute(directory)
  )
    throw directoryRefused();
  const segments = directory.split("/").filter(Boolean);

  if (segments.some((part) => part === ".." || part === "." || part === ".git")) throw directoryRefused();
  const root = await realpath(workspace);
  const rootInfo = await stat(root, { bigint: true });

  if (!rootInfo.isDirectory()) throw directoryRefused();
  let path = root;

  for (const part of segments) {
    path = join(path, part);
    const info = await lstat(path);

    if (info.isSymbolicLink() || !info.isDirectory()) throw directoryRefused();
  }

  const real = await realpath(path);

  if (!isWithin(root, real)) throw directoryRefused();

  return {
    root,
    path: real,
    directory: relative(root, real).split(sep).join("/"),
    rootIdentity: directoryIdentity(`${root}:${rootInfo.dev}:${rootInfo.ino}:${rootInfo.birthtimeNs}`),
    revision: await directoryRevision(real),
  };
}
