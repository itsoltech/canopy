import { dlopen, ptr, type Pointer } from "bun:ffi";
import { join, parse, relative, sep } from "node:path";
import { fileChanged, exactLocation, type FileMutation } from "./file-mutation.ts";

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const DELETE = 0x00010000;
const SHARE_READ_WRITE = 3;
const OPEN_EXISTING = 3;

// OPEN_REPARSE_POINT | BACKUP_SEMANTICS: links are inspected, never followed; directories can be opened.
const NO_FOLLOW = 0x02200000;
const INVALID = 0xffffffffffffffffn;
const WINDOWS_TO_UNIX_MS = 11644473600000n;

const native = () =>
  dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    SetFileInformationByHandle: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    GetFinalPathNameByHandleW: { args: ["u64", "ptr", "u32", "u32"], returns: "u32" },
    ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    WriteFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });

let library: ReturnType<typeof native> | undefined;
const symbols = () => (library ??= native()).symbols;

/** The OS's own long-name, final-case path of the open object. */
function finalPath(handle: bigint): string {
  const buffer = Buffer.alloc(65536);
  const length = symbols().GetFinalPathNameByHandleW(handle, ptr(buffer), buffer.length / 2, 0);

  if (!length || length >= buffer.length / 2) throw fileChanged();
  const path = buffer.subarray(0, length * 2).toString("utf16le");

  return path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.replace(/^\\\\\?\\/, "");
}

function information(handle: bigint, kind: number, size: number) {
  const buffer = Buffer.alloc(size);

  if (!symbols().GetFileInformationByHandleEx(handle, kind, ptr(buffer), size)) throw fileChanged();

  return buffer;
}

function open(path: string, access: number, share: number, directory: boolean): bigint {
  const encoded = Buffer.from(`${path}\0`, "utf16le");
  const handle = symbols().CreateFileW(ptr(encoded), access, share, null, OPEN_EXISTING, NO_FOLLOW, 0n);

  if (handle === INVALID) throw fileChanged();

  try {
    const attributes = information(handle, 9, 8).readUInt32LE(0);

    if (attributes & 0x400 || Boolean(attributes & 0x10) !== directory) throw fileChanged();

    return handle;
  } catch (error) {
    symbols().CloseHandle(handle);
    throw error;
  }
}

function stat(handle: bigint) {
  // FILE_BASIC_INFO: four FILETIMEs and the attributes; FILE_STANDARD_INFO: sizes, links, flags; FILE_ID_INFO.
  const basic = information(handle, 0, 40);
  const standard = information(handle, 1, 24);
  const id = information(handle, 18, 24);

  if (standard[21] || basic.readUInt32LE(32) & 0x410) throw fileChanged("Only regular files can be changed.");

  if (standard.readUInt32LE(16) !== 1)
    throw fileChanged("This file has other hard links, so Canopy will not change it.");

  if (standard[20]) throw fileChanged();

  return {
    id: id.toString("hex"),
    version: `${standard.readBigInt64LE(8)}:${basic.readBigInt64LE(16)}:${basic.readBigInt64LE(24)}`,
    size: Number(standard.readBigInt64LE(8)),
    modified: basic.readBigInt64LE(16) / 10000n - WINDOWS_TO_UNIX_MS,
  };
}

type Transfer = (
  handle: bigint,
  buffer: Pointer | null,
  length: number,
  count: Pointer | null,
  overlapped: Pointer | null,
) => number;

function transfer(
  call: Transfer,
  handle: bigint,
  bytes: Uint8Array,
  offset: number,
  length: number,
  position: number,
): number {
  if (!length) return 0;
  // OVERLAPPED carries the position; the handle is synchronous, so the call completes before it returns.
  const overlapped = Buffer.alloc(32);
  const count = Buffer.alloc(4);
  overlapped.writeBigUInt64LE(BigInt(position), 16);

  if (!call(handle, ptr(bytes, offset), length, ptr(count), ptr(overlapped))) return 0;

  return count.readUInt32LE(0);
}

/**
 * Every ancestor and the file stay open without delete/rename sharing for the whole operation, so none of them
 * can be replaced by a link or moved. Deleting marks the opened object, not a pathname.
 */
export function openWindowsMutation(path: string, writing: boolean): FileMutation {
  if (path.slice(2).includes(":")) throw fileChanged();
  const root = parse(path).root;
  const parents: bigint[] = [];
  let leaf: bigint | undefined;

  const release = () => {
    if (leaf !== undefined) symbols().CloseHandle(leaf);

    for (const handle of parents.reverse()) symbols().CloseHandle(handle);
    leaf = undefined;
    parents.length = 0;
  };

  try {
    const names = relative(root, path).split(sep).filter(Boolean);
    let current = root;
    parents.push(open(current, GENERIC_READ, SHARE_READ_WRITE, true));

    for (const name of names.slice(0, -1)) {
      current = join(current, name);
      parents.push(open(current, GENERIC_READ, SHARE_READ_WRITE, true));
    }

    // Keep the checked directory entry in place until this write or delete finishes.
    leaf = open(path, writing ? GENERIC_READ | GENERIC_WRITE : GENERIC_READ | DELETE, SHARE_READ_WRITE, false);
    const handle = leaf;
    const first = stat(handle);
    // SAFETY: the root handle is always pushed first.
    const parent = parents.at(-1)!;

    const verifyLocation = () => {
      if (!exactLocation(finalPath(handle), path) || !exactLocation(finalPath(parent), current)) throw fileChanged();
    };

    verifyLocation();

    return {
      stat: () => stat(handle),
      read: (bytes, offset) => transfer(symbols().ReadFile, handle, bytes, 0, bytes.length, offset),
      verify() {
        verifyLocation();
        const now = stat(handle);

        if (now.id !== first.id || now.version !== first.version) throw fileChanged();
      },
      write(data) {
        verifyLocation();

        for (let offset = 0; offset < data.length;) {
          const count = transfer(
            symbols().WriteFile,
            handle,
            data,
            offset,
            Math.min(data.length - offset, 1 << 20),
            offset,
          );

          if (!count) throw new Error("Could not write the file.");
          offset += count;
        }

        const end = Buffer.alloc(8);
        end.writeBigInt64LE(BigInt(data.length));

        // FileEndOfFileInfo
        if (!symbols().SetFileInformationByHandle(handle, 6, ptr(end), end.length))
          throw new Error("Could not write the file.");
      },
      delete() {
        verifyLocation();
        const disposition = Buffer.alloc(4);
        disposition.writeUInt32LE(1);

        // FileDispositionInfo: the opened object is removed when this handle closes.
        if (!symbols().SetFileInformationByHandle(handle, 4, ptr(disposition), disposition.length))
          throw new Error("Could not delete the file.");
      },
      close: release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
