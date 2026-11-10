import { runProcess } from "@canopy/process-governor";
import { CommandError } from "./host-types.ts";

/** The system's opener: Finder selects a folder (`-R`) or opens a file; Explorer and xdg-open open either. */
function openerArgs(path: string, select: boolean): string[] {
  switch (process.platform) {
    case "darwin":
      return select ? ["open", "-R", path] : ["open", path];
    case "win32":
      return ["explorer.exe", path];
    default:
      return ["xdg-open", path];
  }
}

/** Explorer exits with 1 even when it opened the path, so on Windows only a failed start counts. */
async function openWithSystem(path: string, select: boolean, what: "folder" | "file"): Promise<void> {
  let code: number | null;

  try {
    ({ code } = await runProcess({ argv: openerArgs(path, select), timeoutMs: 5_000 }, { kind: "utility" }));
  } catch {
    throw new CommandError(
      "REVEAL_UNAVAILABLE",
      what === "folder"
        ? "No file manager is available on this computer. Copy the path instead."
        : "This computer cannot open files with another app. Copy the path instead.",
      true,
    );
  }

  if (code !== 0 && process.platform !== "win32")
    throw new CommandError(
      "REVEAL_FAILED",
      what === "folder"
        ? "The file manager could not open the folder. Copy the path instead."
        : "No app on this computer opened the file. Copy the path instead.",
      true,
    );
}

/** Opens a folder in the file manager of this worker's computer (the caller checked the path). */
export const revealInFileManager = (path: string): Promise<void> => openWithSystem(path, true, "folder");

/** Opens a file in its default app on this worker's computer (the caller checked the path). */
export const openInDefaultApp = (path: string): Promise<void> => openWithSystem(path, false, "file");
