import { CommandError } from "../runtime/host-types.ts";

export interface MutationStat {
  /** The object's identity on its volume; stays the same while its content changes. */
  readonly id: string;
  /** Changes whenever the content or metadata changes. */
  readonly version: string;
  readonly size: number;
  readonly modified: bigint;
}

/**
 * One pinned regular file. Every call acts on the object that was opened and checked, never on a pathname that
 * could have been re-pointed since. The location is verified again right before each change.
 */
export interface FileMutation {
  stat(): MutationStat;
  read(bytes: Uint8Array, offset: number): number;
  /** The file is still where it was opened and has not changed since. */
  verify(): void;
  write(data: Uint8Array): void;
  delete(): void;
  close(): void;
}

export const fileChanged = (message = "The file changed on disk since you opened it. Reload it to see the changes.") =>
  new CommandError("FILE_CHANGED", message, true);

/**
 * The OS reports the stored name of the opened object; it must equal the canonical anchor exactly, so volumes
 * with case-sensitive names are never confused with a differently cased sibling. Only a Windows drive letter,
 * which is case-insensitive by definition, is normalised.
 */
export const exactLocation = (actual: string, expected: string): boolean =>
  process.platform === "win32"
    ? actual.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) ===
      expected.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
    : actual === expected;
