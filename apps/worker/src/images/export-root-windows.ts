import { dlopen, ptr } from "bun:ffi";
import { join, parse } from "node:path";
import { pathParts, rootChanged, type ImageFile, type ImageRoot } from "./export-root.ts";

const native = () =>
  dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    GetFinalPathNameByHandleW: { args: ["u64", "ptr", "u32", "u32"], returns: "u32" },
    ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });

let library: ReturnType<typeof native> | undefined;

/**
 * The leaf stays a Win32 HANDLE. Bun's fs functions use their own descriptor table, so a CRT descriptor from
 * _open_osfhandle is a bad (or a different) file to them.
 */
function windowsImageFile(handle: bigint): ImageFile {
  const { symbols } = (library ??= native());
  let open = true;

  const info = (kind: number, size: number) => {
    const buffer = Buffer.alloc(size);

    if (!open || !symbols.GetFileInformationByHandleEx(handle, kind, ptr(buffer), size))
      throw new Error("Image handle is unavailable.");

    return buffer;
  };

  return {
    stat() {
      // FILE_BASIC_INFO: four FILETIMEs and the attributes; FILE_STANDARD_INFO: sizes, links, flags.
      const basic = info(0, 40);
      const standard = info(1, 24);

      return {
        size: Number(standard.readBigInt64LE(8)),
        regular: !standard[21] && !(basic.readUInt32LE(32) & 0x410),
        links: standard.readUInt32LE(16),
        version: `${basic.readBigInt64LE(16)}:${basic.readBigInt64LE(24)}`,
      };
    },
    path() {
      const buffer = Buffer.alloc(65536);
      const length = open ? symbols.GetFinalPathNameByHandleW(handle, ptr(buffer), buffer.length / 2, 0) : 0;

      if (!length || length >= buffer.length / 2) throw new Error("Image handle is unavailable.");
      const path = buffer.subarray(0, length * 2).toString("utf16le");

      return path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.replace(/^\\\\\?\\/, "");
    },
    read(buffer, offset, length, position) {
      if (!open) throw new Error("Image handle is unavailable.");

      if (!length) return 0;
      // OVERLAPPED carries the position; the handle is synchronous, so ReadFile completes before it returns.
      const overlapped = Buffer.alloc(32);
      const count = Buffer.alloc(4);
      overlapped.writeBigUInt64LE(BigInt(position), 16);

      // A failed read (ERROR_HANDLE_EOF included) reads nothing; callers treat a short file as changed.
      if (!symbols.ReadFile(handle, ptr(buffer, offset), length, ptr(count), ptr(overlapped))) return 0;

      return count.readUInt32LE(0);
    },
    close() {
      if (open) symbols.CloseHandle(handle);
      open = false;
    },
  };
}

/** Each verified parent remains locked against rename/delete while the next child opens. */
export function windowsImageRoot(path: string): ImageRoot {
  const { symbols } = (library ??= native());
  const identities: string[] = [];
  const parts = pathParts(path);

  const release = (handles: bigint[]) => {
    for (const handle of handles.reverse()) symbols.CloseHandle(handle);
  };

  const open = (value: string, directory: boolean) => {
    const encoded = Buffer.from(`${value}\0`, "utf16le");
    // OPEN_REPARSE_POINT | BACKUP_SEMANTICS, sharing reads/writes but never delete/rename.
    const handle = symbols.CreateFileW(ptr(encoded), 0x80000000, 3, null, 3, 0x02200000, 0n);

    if (handle === 0xffffffffffffffffn) throw rootChanged();

    try {
      const tag = Buffer.alloc(8);
      const id = Buffer.alloc(24);

      if (
        !symbols.GetFileInformationByHandleEx(handle, 9, ptr(tag), tag.length) ||
        !symbols.GetFileInformationByHandleEx(handle, 18, ptr(id), id.length)
      )
        throw rootChanged();
      const attributes = tag.readUInt32LE(0);

      if (attributes & 0x400 || Boolean(attributes & 0x10) !== directory) throw rootChanged();

      return { handle, identity: id.toString("hex") };
    } catch (error) {
      symbols.CloseHandle(handle);
      throw error;
    }
  };

  const walk = (children: readonly string[], capture: boolean) => {
    const handles: bigint[] = [];
    let current = parse(path).root;
    const names = ["", ...parts, ...children];

    try {
      for (const [depth, part] of names.entries()) {
        current = join(current, part);
        const entry = open(current, !children.length || depth < names.length - 1);
        handles.push(entry.handle);

        if (depth <= parts.length) {
          if (capture) identities.push(entry.identity);
          else if (entry.identity !== identities[depth]) throw rootChanged();
        }
      }

      return handles;
    } catch (error) {
      release(handles);
      throw error;
    }
  };

  release(walk([], true));

  return {
    path,
    canonical: path,
    verify() {
      release(walk([], false));
    },
    open(children) {
      const handles = walk(children, false);
      // SAFETY: walk opens the drive root first, so it returns at least one handle.
      const leaf = handles.pop()!;

      release(handles);

      return windowsImageFile(leaf);
    },
  };
}
