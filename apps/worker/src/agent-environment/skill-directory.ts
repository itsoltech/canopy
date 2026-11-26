import { isAbsolute, parse, relative, sep } from "node:path";
import { unixSkillDirectory } from "./skill-directory-unix.ts";
import { windowsSkillDirectory } from "./skill-directory-windows.ts";

export interface SkillEntry {
  kind: "directory" | "link" | "file" | "other";
  identity: string;
  version: string;
  changed: string;
}

export interface SkillDirectory {
  readonly path: string;
  readonly fd?: number;
  entry(name: string): SkillEntry | undefined;
  names(limit: number, onEntry?: () => void): string[];
  child(name: string, create?: boolean): SkillDirectory;
  readLink(name: string): string;
  readFile(name: string, expected: SkillEntry, limit: number): { content: Buffer; executable: boolean };
  move(name: string, destination: SkillDirectory): void;
  close(): void;
}

export const directoryError = () => new Error("Couldn't inspect the skill folder. Check its permissions and symlinks.");

export const copyChanged = () => new Error("This copy changed. Refresh the list and review it again.");

export function sameSkillEntry(actual: SkillEntry | undefined, expected: SkillEntry): boolean {
  return (
    actual?.kind === expected.kind &&
    actual.identity === expected.identity &&
    actual.version === expected.version &&
    actual.changed === expected.changed
  );
}

export const moveError = () =>
  new Error("Couldn't move the copy. Check the archive location, permissions and free space.");

export function withSkillDirectory<T>(path: string, run: (directory: SkillDirectory) => T): T | undefined {
  if (!isAbsolute(path)) throw directoryError();
  const root = parse(path).root;
  const directory = process.platform === "win32" ? windowsSkillDirectory(root) : unixSkillDirectory(root);
  const pins = [directory];

  try {
    let current = directory;

    for (const part of relative(root, path).split(sep).filter(Boolean)) {
      const entry = current.entry(part);

      if (!entry) return undefined;

      if (entry.kind !== "directory") throw directoryError();
      current = current.child(part);
      pins.push(current);
    }

    return run(current);
  } finally {
    for (const pin of pins.reverse()) pin.close();
  }
}
