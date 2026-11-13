import type { directoryPath } from "./thread-directory-path.ts";

export type DirectoryTarget = Awaited<ReturnType<typeof directoryPath>>;

export interface DirectoryChild {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: bigint;
  modifiedMs: bigint;
}

/** The iterator and metadata share a pinned directory, never a re-resolved child path. */
export interface DirectoryHandle {
  read(): Promise<DirectoryChild | undefined>;
  revision(): Promise<string>;
  close(): Promise<void>;
}

export class VerifiedDirectory {
  static async open(target: DirectoryTarget): Promise<DirectoryHandle> {
    if (process.platform === "win32") {
      const { openWindowsDirectory } = await import("./directory-handle-windows.ts");

      return openWindowsDirectory(target);
    }

    const { openUnixDirectory } = await import("./directory-handle-unix.ts");

    return openUnixDirectory(target);
  }
}
