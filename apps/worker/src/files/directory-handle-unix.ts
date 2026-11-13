import { CString, dlopen, ptr } from "bun:ffi";
import { closeSync, constants, fstatSync } from "node:fs";
import type { DirectoryChild, DirectoryHandle, DirectoryTarget } from "./directory-handle.ts";
import { directoryIdentity, directoryRefused } from "./thread-directory-path.ts";

const mac = process.platform === "darwin";

const native = () =>
  dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    fdopendir: { args: ["i32"], returns: "ptr" },
    readdir: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    fstatat: { args: ["i32", "cstring", "ptr", "i32"], returns: "i32" },
  });

let library: ReturnType<typeof native> | undefined;
const cstring = (value: string) => Buffer.from(`${value}\0`);

const revision = (fd: number) => {
  const info = fstatSync(fd, { bigint: true });

  return directoryIdentity(`${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`);
};

/** Walk from / with openat(O_NOFOLLOW); even the canonical root's ancestors are verified. */
export async function openUnixDirectory(target: DirectoryTarget): Promise<DirectoryHandle> {
  if (!["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch))
    throw directoryRefused();
  const { symbols } = (library ??= native());
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | (mac ? 0x1000000 : 0x80000);
  let fd = symbols.openat(mac ? -2 : -100, cstring("/"), flags);

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
      const next = symbols.openat(fd, cstring(parts[depth]!), flags);

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
          if (symbols.fstatat(owned, cstring(name), ptr(metadata), mac ? 0x20 : 0x100) !== 0) continue;

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

/** struct stat layouts for the worker release targets: Darwin arm64, Linux x64/arm64. */
function child(name: string, info: Buffer): DirectoryChild {
  const mode = mac ? info.readUInt16LE(4) : info.readUInt32LE(process.arch === "arm64" ? 16 : 24);
  const type = mode & 0xf000;
  const modified = mac ? 48 : 88;

  return {
    name,
    kind: kind(type),
    size: info.readBigInt64LE(mac ? 96 : 48),
    modifiedMs: info.readBigInt64LE(modified) * 1000n + info.readBigInt64LE(modified + 8) / 1_000_000n,
  };
}

function kind(type: number): DirectoryChild["kind"] {
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
