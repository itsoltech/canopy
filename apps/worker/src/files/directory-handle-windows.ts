import { dlopen, ptr } from "bun:ffi";
import { join, parse, relative } from "node:path";
import type { DirectoryChild, DirectoryHandle, DirectoryTarget } from "./directory-handle.ts";
import { directoryPath, directoryRefused, directoryRevision } from "./thread-directory-path.ts";

const native = () =>
  dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });

let library: ReturnType<typeof native> | undefined;

/** Pin every ancestor without FILE_SHARE_DELETE, then enumerate metadata on the final HANDLE. */
export async function openWindowsDirectory(target: DirectoryTarget): Promise<DirectoryHandle> {
  const { symbols } = (library ??= native());
  const pins: bigint[] = [];
  const root = parse(target.path).root;
  let path = root;

  try {
    for (const part of ["", ...relative(root, target.path).split(/[\\/]/).filter(Boolean)]) {
      path = join(path, part);
      const encoded = Buffer.from(`${path}\0`, "utf16le");
      // OPEN_REPARSE_POINT | BACKUP_SEMANTICS; sharing permits reads/writes, never rename/delete.
      const handle = symbols.CreateFileW(ptr(encoded), 0x80000000, 3, null, 3, 0x02200000, 0n);

      if (handle === 0xffffffffffffffffn) throw directoryRefused();
      pins.push(handle);
      const tag = Buffer.alloc(8);

      if (!symbols.GetFileInformationByHandleEx(handle, 9, ptr(tag), tag.length)) throw directoryRefused();
      const attributes = tag.readUInt32LE(0);

      if (!(attributes & 0x10) || attributes & 0x400) throw directoryRefused();
    }

    const current = await directoryPath(target.root, target.directory);

    if (current.rootIdentity !== target.rootIdentity || current.revision !== target.revision) throw directoryRefused();
    const handle = pins.at(-1)!;
    const buffer = Buffer.alloc(64 * 1024);
    let offset = -1;
    let ended = false;
    let closed = false;

    return {
      async read() {
        while (!closed && !ended) {
          if (offset < 0) {
            // FileIdBothDirectoryInfo returns names, sizes, attributes and times from this handle.
            if (!symbols.GetFileInformationByHandleEx(handle, 10, ptr(buffer), buffer.length)) {
              if (symbols.GetLastError() !== 18) throw directoryRefused(); // ERROR_NO_MORE_FILES
              ended = true;

              return;
            }

            offset = 0;
          }

          const start = offset;
          const next = buffer.readUInt32LE(start);
          offset = next ? start + next : -1;
          const name = buffer.toString("utf16le", start + 104, start + 104 + buffer.readUInt32LE(start + 60));

          if (name === "." || name === "..") continue;
          const attributes = buffer.readUInt32LE(start + 56);

          const child: DirectoryChild = {
            name,
            kind: attributes & 0x400 ? "symlink" : attributes & 0x10 ? "directory" : "file",
            size: buffer.readBigInt64LE(start + 40),
            modifiedMs: buffer.readBigInt64LE(start + 24) / 10_000n - 11_644_473_600_000n,
          };

          return child;
        }

        return undefined;
      },
      async revision() {
        return closed ? "" : directoryRevision(target.path); // All path components remain pinned.
      },
      async close() {
        if (closed) return;
        closed = true;

        for (const pin of pins.reverse()) symbols.CloseHandle(pin);
      },
    };
  } catch (cause) {
    for (const pin of pins.reverse()) symbols.CloseHandle(pin);
    throw cause;
  }
}
