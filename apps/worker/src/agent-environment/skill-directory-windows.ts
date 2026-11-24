import { dlopen, ptr } from "bun:ffi";
import { lstatSync, mkdirSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { pinWindowsDirectory, releaseWindowsDirectory } from "../files/directory-handle-windows.ts";
import { moveError, type SkillDirectory } from "./skill-directory.ts";

const native = () =>
  dlopen("kernel32.dll", {
    MoveFileExW: { args: ["ptr", "ptr", "u32"], returns: "i32" },
  });

let library: ReturnType<typeof native> | undefined;
const wide = (path: string) => Buffer.from(`${path}\0`, "utf16le");

export function windowsSkillDirectory(path: string): SkillDirectory {
  const pin = pinWindowsDirectory(path);

  return {
    path,
    entry(name) {
      const stat = lstatSync(join(path, name), { bigint: true, throwIfNoEntry: false });

      if (!stat) return undefined;

      return {
        kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
        identity: `${stat.dev}:${stat.ino}`,
        version: `${stat.mode}:${stat.size}:${stat.mtimeNs}`,
        changed: String(stat.ctimeNs),
      };
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
