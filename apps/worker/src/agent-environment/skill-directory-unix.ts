import { CString, dlopen, ptr, read, toArrayBuffer } from "bun:ffi";
import { constants, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { directoryCString, unixDirectorySymbols, unixEntryKind } from "../files/directory-handle-unix.ts";
import { directoryError, moveError, type SkillDirectory, type SkillEntry } from "./skill-directory.ts";

const mac = process.platform === "darwin";
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | (mac ? 0x1000000 : 0x80000);
const rename = { args: ["i32", "cstring", "i32", "cstring", "u32"], returns: "i32" } as const;
const errno = { args: [], returns: "ptr" } as const;
const mkdirat = { args: ["i32", "cstring", "i32"], returns: "i32" } as const;

function operations() {
  if (mac) {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", { renameatx_np: rename, __error: errno, mkdirat });

    return { rename: lib.symbols.renameatx_np, errno: lib.symbols.__error, mkdirat: lib.symbols.mkdirat };
  }

  const lib = dlopen("libc.so.6", { renameat2: rename, __errno_location: errno, mkdirat });

  return { rename: lib.symbols.renameat2, errno: lib.symbols.__errno_location, mkdirat: lib.symbols.mkdirat };
}

let native: ReturnType<typeof operations> | undefined;

/** Darwin uses the inode64 struct stat on both architectures. Linux arm64 and x64 differ in st_mode's offset. */
function entry(info: Buffer): SkillEntry {
  const mode = mac ? info.readUInt16LE(4) : info.readUInt32LE(process.arch === "arm64" ? 16 : 24);
  const kind = unixEntryKind(mode & 0xf000);
  const dev = mac ? info.readUInt32LE(0) : info.readBigUInt64LE(0);
  const ino = info.readBigUInt64LE(8);
  const size = info.readBigInt64LE(mac ? 96 : 48);
  const time = (offset: number) => `${info.readBigInt64LE(offset)}:${info.readBigInt64LE(offset + 8)}`;

  return {
    kind: kind === "symlink" ? "link" : kind,
    identity: `${dev}:${ino}`,
    version: `${mode}:${size}:${time(mac ? 48 : 88)}`,
    changed: time(mac ? 64 : 104),
  };
}

export function unixSkillDirectory(path: string, descriptor?: number): SkillDirectory {
  if (!["linux", "darwin"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
    throw directoryError();
  const symbols = unixDirectorySymbols();
  const ops = (native ??= operations());
  const err = ops.errno();

  if (!err) throw directoryError();
  const fd = descriptor ?? openSync(path, flags);
  const metadata = Buffer.alloc(256);

  return {
    path,
    fd,
    entry(name) {
      if (symbols.fstatat(fd, directoryCString(name), ptr(metadata), mac ? 0x20 : 0x100) === 0) return entry(metadata);

      if (read.i32(err) === 2) return undefined; // ENOENT
      throw directoryError();
    },
    names(limit, onEntry) {
      const copy = symbols.openat(fd, directoryCString("."), flags);

      if (copy < 0) throw directoryError();
      const stream = symbols.fdopendir(copy);

      if (!stream) {
        closeSync(copy);
        throw directoryError();
      }

      try {
        const names: string[] = [];
        const errnoValue = new Int32Array(toArrayBuffer(err, 0, 4));

        for (;;) {
          errnoValue[0] = 0;
          const item = symbols.readdir(stream);

          if (!item) {
            if (errnoValue[0]) throw directoryError();

            return names.sort();
          }

          const name = new CString(item, mac ? 21 : 19).toString();

          if (name === "." || name === "..") continue;
          onEntry?.();

          if (names.length >= limit) throw new Error("Too many entries to inspect this skill folder.");
          names.push(name);
        }
      } finally {
        symbols.closedir(stream);
      }
    },
    child(name, create) {
      const bytes = directoryCString(name);

      if (create && ops.mkdirat(fd, bytes, 0o700) !== 0 && read.i32(err) !== 17) throw moveError(); // EEXIST
      const child = symbols.openat(fd, bytes, flags);

      if (child < 0) throw directoryError();

      return unixSkillDirectory(join(path, name), child);
    },
    move(name, destination) {
      const bytes = directoryCString(name);

      // RENAME_EXCL / RENAME_NOREPLACE also protects a concurrent replacement during rollback.
      if (destination.fd === undefined || ops.rename(fd, bytes, destination.fd, bytes, mac ? 4 : 1) !== 0)
        throw moveError();
    },
    close: () => closeSync(fd),
  };
}
