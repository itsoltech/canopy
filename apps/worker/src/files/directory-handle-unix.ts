import { CString, dlopen, ptr } from "bun:ffi";
import { closeSync, constants, fstatSync } from "node:fs";
import type { DirectoryChild, DirectoryHandle, DirectoryTarget } from "./directory-handle.ts";
import { directoryIdentity, directoryRefused } from "./thread-directory-path.ts";

const mac = process.platform === "darwin";

function native() {
  const path = mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const openat = { args: ["i32", "cstring", "i32"], returns: "i32" } as const;
  const closedir = { args: ["ptr"], returns: "i32" } as const;
  const fdopendir = { args: ["i32"], returns: "ptr" } as const;
  const readdir = { args: ["ptr"], returns: "ptr" } as const;
  const fstatat = { args: ["i32", "cstring", "ptr", "i32"], returns: "i32" } as const;

  // Darwin x64 exports both inode ABIs. Match the 64-bit dirent and stat layouts read below.
  if (mac && process.arch === "x64") {
    const lib = dlopen(path, {
      openat,
      closedir,
      fdopendir$INODE64: fdopendir,
      readdir$INODE64: readdir,
      fstatat$INODE64: fstatat,
    });

    return {
      ...lib,
      symbols: {
        ...lib.symbols,
        fdopendir: lib.symbols.fdopendir$INODE64,
        readdir: lib.symbols.readdir$INODE64,
        fstatat: lib.symbols.fstatat$INODE64,
      },
    };
  }

  return dlopen(path, { openat, closedir, fdopendir, readdir, fstatat });
}

let library: ReturnType<typeof native> | undefined;
export const unixDirectorySymbols = () => (library ??= native()).symbols;
export const directoryCString = (value: string) => Buffer.from(`${value}\0`);

const revision = (fd: number) => {
  const info = fstatSync(fd, { bigint: true });

  return directoryIdentity(`${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`);
};

/** Walk from / with openat(O_NOFOLLOW); even the canonical root's ancestors are verified. */
export async function openUnixDirectory(target: DirectoryTarget): Promise<DirectoryHandle> {
  if (!["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch))
    throw directoryRefused();
  const symbols = unixDirectorySymbols();
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | (mac ? 0x1000000 : 0x80000);
  let fd = symbols.openat(mac ? -2 : -100, directoryCString("/"), flags);

  if (fd < 0) throw directoryRefused();

  try {
    const parts = [...target.root.split("/").filter(Boolean), ...target.directory.split("/").filter(Boolean)];
    const rootDepth = target.root.split("/").filter(Boolean).length;

    for (let depth = 0; depth <= parts.length; depth++) {
      if (depth === rootDepth) {
        const info = fstatSync(fd, { bigint: true });
        const identity = directoryIdentity(`${target.root}:${info.dev}:${info.ino}:${info.birthtimeNs}`);

        if (identity !== target.rootIdentity) throw directoryRefused();
      }

      if (depth === parts.length) break;
      const next = symbols.openat(fd, directoryCString(parts[depth]!), flags);

      if (next < 0) throw directoryRefused();
      closeSync(fd);
      fd = next;
    }

    if (revision(fd) !== target.revision) throw directoryRefused();
    const stream = symbols.fdopendir(fd);

    if (!stream) throw directoryRefused();
    const owned = fd;
    fd = -1; // fdopendir owns this descriptor, including on cursor expiration.
    let closed = false;
    const metadata = Buffer.alloc(256);

    return {
      async read() {
        while (!closed) {
          const entry = symbols.readdir(stream);

          if (!entry) return;
          const name = new CString(entry, mac ? 21 : 19).toString();

          if (name === "." || name === "..") continue;

          // AT_SYMLINK_NOFOLLOW: metadata cannot traverse a substituted leaf symlink.
          if (symbols.fstatat(owned, directoryCString(name), ptr(metadata), mac ? 0x20 : 0x100) !== 0) continue;

          return child(name, metadata);
        }

        return undefined;
      },
      async revision() {
        return closed ? "" : revision(owned);
      },
      async close() {
        if (closed) return;
        closed = true;
        symbols.closedir(stream);
      },
    };
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** The Darwin inode64 layout is shared by x64 and arm64. Linux mode offsets depend on the CPU. */
function child(name: string, info: Buffer): DirectoryChild {
  const mode = mac ? info.readUInt16LE(4) : info.readUInt32LE(process.arch === "arm64" ? 16 : 24);
  const type = mode & 0xf000;
  const modified = mac ? 48 : 88;

  return {
    name,
    kind: unixEntryKind(type),
    size: info.readBigInt64LE(mac ? 96 : 48),
    modifiedMs: info.readBigInt64LE(modified) * 1000n + info.readBigInt64LE(modified + 8) / 1_000_000n,
  };
}

export function unixEntryKind(type: number): DirectoryChild["kind"] {
  switch (type) {
    case 0x4000:
      return "directory";
    case 0x8000:
      return "file";
    case 0xa000:
      return "symlink";
    default:
      return "other";
  }
}
