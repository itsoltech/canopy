import { spawn, type ChildProcess } from "node:child_process";
import { governNodeSpawn } from "@canopy/process-governor";
import { CommandError } from "./host-types.ts";

/** The system opener: a folder opens in the file manager, a file in its default app. */
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

const unavailable = (what: "folder" | "file") =>
  new CommandError(
    "REVEAL_UNAVAILABLE",
    what === "folder"
      ? "No file manager is available on this computer. Copy the path instead."
      : "This computer cannot open files with another app. Copy the path instead.",
    true,
  );

const failed = (what: "folder" | "file") =>
  new CommandError(
    "REVEAL_FAILED",
    what === "folder"
      ? "The file manager could not open the folder. Copy the path instead."
      : "No app on this computer opened the file. Copy the path instead.",
    true,
  );

/**
 * The opener runs detached with a visible window: `windowsHide` (the process governor's capture) starts Explorer
 * hidden, so nothing would appear. Explorer exits with 1 even after opening a path, so on Windows a started
 * process counts as success; elsewhere the opener's exit code tells, and one still running after 5 s is left be.
 */
function openWithSystem(path: string, what: "folder" | "file"): Promise<void> {
  const [command, ...args] = openerArgs(path);

  return new Promise((resolve, reject) => {
    let opener: ChildProcess;

    try {
      opener = governNodeSpawn("utility", () =>
        spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false }),
      );
    } catch {
      reject(unavailable(what));

      return;
    }

    const done = (error?: CommandError) => {
      clearTimeout(timer);
      opener.unref();

      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => done(), 5_000);
    opener.once("error", () => done(unavailable(what)));

    if (process.platform === "win32") opener.once("spawn", () => done());
    else opener.once("exit", (code) => done(code === 0 ? undefined : failed(what)));
  });
}

/** Opens a folder in the file manager of this worker's computer (the caller checked the path). */
export const revealInFileManager = (path: string): Promise<void> => openWithSystem(path, "folder");

/** Opens a file in its default app on this worker's computer (the caller checked the path). */
export const openInDefaultApp = (path: string): Promise<void> => openWithSystem(path, "file");
