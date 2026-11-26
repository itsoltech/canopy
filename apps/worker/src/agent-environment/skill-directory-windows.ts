import { dlopen, ptr } from "bun:ffi";
import { lstatSync, mkdirSync, opendirSync, readlinkSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { pinWindowsDirectory, releaseWindowsDirectory } from "../files/directory-handle-windows.ts";
import { copyChanged, moveError, sameSkillEntry, type SkillDirectory, type SkillEntry } from "./skill-directory.ts";
import { readSkillBytes } from "./skill-files.ts";

const native = () =>
  dlopen("kernel32.dll", {
    MoveFileExW: { args: ["ptr", "ptr", "u32"], returns: "i32" },
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });

let library: ReturnType<typeof native> | undefined;
const wide = (path: string) => Buffer.from(`${path}\0`, "utf16le");

function entry(stat: BigIntStats): SkillEntry {
  return {
    kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    identity: `${stat.dev}:${stat.ino}`,
    version: `${stat.mode}:${stat.size}:${stat.mtimeNs}`,
    changed: String(stat.ctimeNs),
  };
}

function readFile(path: string, expected: SkillEntry, limit: number) {
  const { symbols } = (library ??= native());
  // Read the leaf itself. The handle prevents writes and replacement until metadata and content have been checked.
  const handle = symbols.CreateFileW(ptr(wide(path)), 0x80000000, 1, null, 3, 0x00200000, 0n);

  if (handle === 0xffffffffffffffffn) throw copyChanged();

  try {
    const tag = Buffer.alloc(8);

    if (!symbols.GetFileInformationByHandleEx(handle, 9, ptr(tag), tag.length) || tag.readUInt32LE(0) & 0x410)
      throw copyChanged();
    const stat = lstatSync(path, { bigint: true });

    if (!sameSkillEntry(entry(stat), expected)) throw copyChanged();

    if (stat.nlink !== 1n) throw new Error("A skill can only contain regular files without links.");

    if (stat.size > BigInt(limit)) throw new Error("Skills are limited to 1 MiB per file and 25 MiB in total.");
    const count = Buffer.alloc(4);

    const content = readSkillBytes(Number(stat.size) + 1, (buffer, offset) => {
      if (!symbols.ReadFile(handle, ptr(buffer, offset), buffer.length - offset, ptr(count), null)) throw copyChanged();

      return count.readUInt32LE(0);
    });

    if (BigInt(content.length) !== stat.size || !sameSkillEntry(entry(lstatSync(path, { bigint: true })), expected))
      throw copyChanged();

    return { content, executable: (stat.mode & 0o111n) !== 0n };
  } finally {
    symbols.CloseHandle(handle);
  }
}

export function windowsSkillDirectory(path: string): SkillDirectory {
  const pin = pinWindowsDirectory(path);

  return {
    path,
    entry(name) {
      const stat = lstatSync(join(path, name), { bigint: true, throwIfNoEntry: false });

      return stat && entry(stat);
    },
    names(limit, onEntry) {
      const directory = opendirSync(path);
      const names: string[] = [];

      try {
        for (let item = directory.readSync(); item; item = directory.readSync()) {
          onEntry?.();

          if (names.length >= limit) throw new Error("Too many entries to inspect this skill folder.");
          names.push(item.name);
        }

        return names.sort();
      } finally {
        directory.closeSync();
      }
    },
    child(name, create) {
      const child = join(path, name);

      if (create) {
        try {
          mkdirSync(child, { mode: 0o700 });
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw moveError();
        }
      }

      return windowsSkillDirectory(child);
    },
    readLink: (name) => readlinkSync(join(path, name)),
    readFile: (name, expected, limit) => readFile(join(path, name), expected, limit),
    move(name, destination) {
      const { symbols } = (library ??= native());

      const source = wide(join(path, name));
      const archived = wide(join(destination.path, name));

      // Neither replace-existing nor cross-volume copying is permitted.
      if (!symbols.MoveFileExW(ptr(source), ptr(archived), 0)) throw moveError();
    },
    close: () => releaseWindowsDirectory(pin),
  };
}
