import { spawn, type ChildProcess } from "node:child_process";
import { governNodeSpawn } from "@canopy/process-governor";
import { CommandError } from "./host-types.ts";

/** The system opener: it shows a folder in the file manager (Finder, Explorer, the desktop's own). */
function openerArgs(path: string): [string, ...string[]] {
  switch (process.platform) {
    case "darwin":
      return ["open", path];
    case "win32":
      return ["explorer.exe", path];
    default:
      return ["xdg-open", path];
  }
}

const unavailable = () =>
  new CommandError("REVEAL_UNAVAILABLE", "No file manager is available on this computer. Copy the path instead.", true);

const failed = () =>
  new CommandError("REVEAL_FAILED", "The file manager could not open the folder. Copy the path instead.", true);

/**
 * Opens a folder in the file manager of this worker's computer (the caller checked the path).
 *
 * The opener runs detached with a visible window: `windowsHide` (the process governor's capture) starts Explorer
 * hidden, so nothing would appear. Explorer exits with 1 even after opening a folder, so on Windows a started
 * process counts as success; elsewhere the opener's exit code tells, and one still running after 5 s is left be.
 */
export function revealInFileManager(path: string): Promise<void> {
  const [command, ...args] = openerArgs(path);

  return new Promise((resolve, reject) => {
    let opener: ChildProcess;

    try {
      opener = governNodeSpawn("utility", () =>
        spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false }),
      );
    } catch {
      reject(unavailable());

      return;
    }

    const done = (error?: CommandError) => {
      clearTimeout(timer);
      opener.unref();

      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => done(), 5_000);
    opener.once("error", () => done(unavailable()));

    if (process.platform === "win32") opener.once("spawn", () => done());
    else opener.once("exit", (code) => done(code === 0 ? undefined : failed()));
  });
}
