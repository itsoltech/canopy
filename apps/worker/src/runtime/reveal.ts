import { runProcess } from "@canopy/process-governor";
import { CommandError } from "./host-types.ts";

/** The system file manager's command for a folder: Finder selects it, Explorer and xdg-open open it. */
function revealArgs(path: string): string[] {
  switch (process.platform) {
    case "darwin":
      return ["open", "-R", path];
    case "win32":
      return ["explorer.exe", path];
    default:
      return ["xdg-open", path];
  }
}

/**
 * Opens a folder in the file manager of this worker's computer (the caller checked the path). Explorer exits
 * with 1 even when it opened the folder, so on Windows only a failed start counts.
 */
export async function revealInFileManager(path: string): Promise<void> {
  let code: number | null;

  try {
    ({ code } = await runProcess({ argv: revealArgs(path), timeoutMs: 5_000 }, { kind: "utility" }));
  } catch {
    throw new CommandError(
      "REVEAL_UNAVAILABLE",
      "No file manager is available on this computer. Copy the path instead.",
      true,
    );
  }

  if (code !== 0 && process.platform !== "win32")
    throw new CommandError("REVEAL_FAILED", "The file manager could not open the folder. Copy the path instead.", true);
}
