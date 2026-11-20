import { dlopen } from "bun:ffi";
import { constants, closeSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";
import { basename, dirname, sep } from "node:path";
import { descriptorPath } from "../images/descriptor-path.ts";
import { fileChanged, exactLocation, type FileMutation } from "./file-mutation.ts";

const mac = process.platform === "darwin";
const directory = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const leafFlags = constants.O_NOFOLLOW | constants.O_NONBLOCK;
const nameBytes = (name: string) => Buffer.from(`${name}\0`);

const signatures = {
  openat: { args: ["i32", "cstring", "i32"], returns: "i32" },
  mkdirat: { args: ["i32", "cstring", "i32"], returns: "i32" },
  renameat: { args: ["i32", "cstring", "i32", "cstring"], returns: "i32" },
  unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
} as const;

const renameFlags = { args: ["i32", "cstring", "i32", "cstring", "u32"], returns: "i32" } as const;
const unix = () => dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", signatures);
const macRename = () => dlopen("/usr/lib/libSystem.B.dylib", { renameatx_np: renameFlags });
const linuxRename = () => dlopen("libc.so.6", { renameat2: renameFlags });
let library: ReturnType<typeof unix> | undefined;
let macLibrary: ReturnType<typeof macRename> | undefined;
let linuxLibrary: ReturnType<typeof linuxRename> | undefined;

function stat(fd: number) {
  const info = fstatSync(fd, { bigint: true });

  if (!info.isFile()) throw fileChanged("Only regular files can be changed.");

  if (info.nlink !== 1n) throw fileChanged("This file has other hard links, so Canopy will not change it.");

  return {
    id: `${info.dev}:${info.ino}`,
    version: `${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
    size: Number(info.size),
    modified: info.mtimeNs / 1_000_000n,
  };
}

export function openUnixMutation(path: string, writing: boolean): FileMutation {
  if (process.platform !== "linux" && process.platform !== "darwin") throw fileChanged();
  const { symbols } = (library ??= unix());
  const parentPath = dirname(path);
  const leaf = nameBytes(basename(path));
  let parent = openSync("/", directory);
  let fd = -1;

  try {
    for (const part of parentPath.split(sep).filter(Boolean)) {
      const next = symbols.openat(parent, nameBytes(part), directory);

      if (next < 0) throw fileChanged();
      closeSync(parent);
      parent = next;
    }

    fd = symbols.openat(parent, leaf, leafFlags | (writing ? constants.O_RDWR : constants.O_RDONLY));

    if (fd < 0) throw fileChanged();
    const first = stat(fd);

    const verifyLocation = () => {
      if (!exactLocation(descriptorPath(parent), parentPath) || !exactLocation(descriptorPath(fd), path))
        throw fileChanged();
    };

    verifyLocation();

    return {
      stat: () => stat(fd),
      read: (bytes, offset) => readSync(fd, bytes, 0, bytes.length, offset),
      verify() {
        verifyLocation();
        const current = stat(fd);

        if (current.id !== first.id || current.version !== first.version) throw fileChanged();
      },
      write(data) {
        verifyLocation();

        for (let offset = 0; offset < data.length;) {
          const count = writeSync(fd, data, offset, data.length - offset, offset);

          if (!count) throw new Error("Could not write the file.");
          offset += count;
        }

        ftruncateSync(fd, data.length);
      },
      delete() {
        verifyLocation();
        deletePinned(parent, leaf, first.id);
      },
      close() {
        closeSync(fd);
        closeSync(parent);
      },
    };
  } catch (error) {
    if (fd >= 0) closeSync(fd);
    closeSync(parent);
    throw error;
  }
}

/** Move aside atomically, then delete only the inode that was opened and checked. */
function deletePinned(parent: number, leaf: Buffer, expected: string) {
  const { symbols } = (library ??= unix());

  // Resolve the exclusive-restore primitive before moving anything.
  const restore = mac
    ? (macLibrary ??= macRename()).symbols.renameatx_np
    : (linuxLibrary ??= linuxRename()).symbols.renameat2;

  const temp = nameBytes(`.canopy-delete-${crypto.randomUUID()}`);
  const held = nameBytes("file");

  if (symbols.mkdirat(parent, temp, 0o700) !== 0) throw fileChanged();
  const dir = symbols.openat(parent, temp, directory);
  let moved = false;
  let failure: unknown;

  try {
    if (dir < 0 || symbols.renameat(parent, leaf, dir, held) !== 0) throw fileChanged();
    moved = true;
    const fd = symbols.openat(dir, held, constants.O_RDONLY | leafFlags);

    if (fd < 0) throw fileChanged();

    try {
      if (stat(fd).id !== expected || symbols.unlinkat(dir, held, 0) !== 0) throw fileChanged();
      moved = false;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    failure = error;
  }

  // Put the entry back before anything is reported; the first failure stays the cause of a failed restore.
  const restored = !moved || restore(dir, held, parent, leaf, mac ? 0x4 : 0x1) === 0;

  if (dir >= 0) closeSync(dir);

  if (!restored) {
    const error = fileChanged(
      "The file changed and could not be put back. Its original entry is in a .canopy-delete folder.",
    );

    if (failure !== undefined) error.cause = failure;
    throw error;
  }

  symbols.unlinkat(parent, temp, mac ? 0x80 : 0x200);

  if (failure !== undefined) throw failure;
}
