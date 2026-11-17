import { dlopen } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { CommandError } from "../runtime/host-types.ts";
import { diffBytes, type DiffBudget } from "./diff-process.ts";
import { openWindowsDiffFile } from "./diff-source-windows.ts";

export function validDiffPath(path: string) {
  return (
    !!path &&
    path.length <= 4096 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !/^[a-z]:/i.test(path) &&
    !path.split("/").some((part) => !part || [".", "..", ".git"].includes(part))
  );
}

export const diffRefused = () => new CommandError("DIFF_PATH_INVALID", "Reload changes to try again.", true);

const native = () =>
  dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: ["i32", "cstring", "i32"], returns: "i32" },
  });

let library: ReturnType<typeof native> | undefined;

/** Pin every ancestor, refusing symlinks even when another process swaps one during the walk. */
function openUnix(root: string, path: string): number {
  const { symbols } = (library ??= native());
  const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let fd = openSync("/", dirFlags);

  try {
    const parts = [...root.split("/").filter(Boolean), ...path.split("/")];
    const rootDepth = root.split("/").filter(Boolean).length;

    for (let index = 0; index < parts.length; index++) {
      if (index === rootDepth) {
        const pinned = fstatSync(fd);
        const expected = statSync(root);

        if (pinned.ino !== expected.ino || pinned.dev !== expected.dev) throw diffRefused();
      }

      const flags =
        index === parts.length - 1 ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : dirFlags;

      const next = symbols.openat(fd, Buffer.from(`${parts[index]}\0`), flags);

      if (next < 0) throw diffRefused();
      closeSync(fd);
      fd = next;
    }

    const owned = fd;
    fd = -1;

    return owned;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** Only regular file bytes enter the private snapshot; links and submodules get metadata instead. */
export function copyDiffSource(root: string, path: string, destination: string, budget: DiffBudget) {
  if (!validDiffPath(path)) throw diffRefused();
  const opened = process.platform === "win32" ? openWindowsDiffFile(root, path) : undefined;
  const source = opened?.fd ?? openUnix(root, path);
  let target: number | undefined;

  try {
    const before = fstatSync(source);

    if (!before.isFile()) throw diffRefused();
    target = openSync(destination, "wx", 0o600);
    const chunk = Buffer.alloc(64 * 1024);
    let count: number;

    while ((count = readSync(source, chunk, 0, chunk.length, null)) > 0) {
      diffBytes(budget, count);
      writeFileSync(target, chunk.subarray(0, count));
    }

    const after = fstatSync(source);

    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new CommandError("DIFF_CHANGED", "Files changed while loading. Reload changes to try again.", false);
  } finally {
    if (opened) opened.close();
    else closeSync(source);

    if (target !== undefined) closeSync(target);
  }
}
