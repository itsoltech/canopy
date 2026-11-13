import { dlopen, ptr } from "bun:ffi";
import { join, parse } from "node:path";
import { pathParts, rootChanged, type ImageRoot } from "./export-root.ts";

const native = () =>
  dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });

let library: ReturnType<typeof native> | undefined;
let crt: ReturnType<typeof openCrt> | undefined;
const openCrt = () => dlopen("ucrtbase.dll", { _open_osfhandle: { args: ["u64", "i32"], returns: "i32" } });

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

      try {
        const fd = (crt ??= openCrt()).symbols._open_osfhandle(handles.at(-1)!, 0x8000);

        if (fd < 0) throw rootChanged();
        handles.pop(); // The CRT descriptor now owns the leaf HANDLE; closeSync releases it.

        return fd;
      } finally {
        release(handles);
      }
    },
  };
}
