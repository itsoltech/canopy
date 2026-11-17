import { dlopen, ptr } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { join, parse, relative } from "node:path";
import { diffRefused } from "./diff-source.ts";

const native = () =>
  dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });

let library: ReturnType<typeof native> | undefined;

/** Hold ancestors and leaf without FILE_SHARE_DELETE until the byte copy has completed. */
export function openWindowsDiffFile(root: string, path: string) {
  const { symbols } = (library ??= native());
  const pins: bigint[] = [];
  const target = join(root, path);
  const volume = parse(target).root;
  const parts = ["", ...relative(volume, target).split(/[\\/]/).filter(Boolean)];
  let current = volume;

  const release = () => {
    for (const pin of pins.reverse()) symbols.CloseHandle(pin);
  };

  try {
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const encoded = Buffer.from(`${current}\0`, "utf16le");
      const handle = symbols.CreateFileW(ptr(encoded), 0x80000000, 3, null, 3, 0x02200000, 0n);

      if (handle === 0xffffffffffffffffn) throw diffRefused();
      pins.push(handle);
      const tag = Buffer.alloc(8);

      if (!symbols.GetFileInformationByHandleEx(handle, 9, ptr(tag), tag.length)) throw diffRefused();
      const attributes = tag.readUInt32LE(0);
      const directory = !!(attributes & 0x10);

      if (attributes & 0x400 || directory !== index < parts.length - 1) throw diffRefused();
    }

    const fd = openSync(target, "r");

    return {
      fd,
      close() {
        closeSync(fd);
        release();
      },
    };
  } catch (cause) {
    release();
    throw cause;
  }
}
