import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BrowserWindow, Tray } from "electron";
import { createShutdownWindow } from "./shutdown-window.ts";

interface ShutdownOptions {
  controller: ChildProcessWithoutNullStreams | undefined;
  controllerExited: boolean;
  installingUpdate: boolean;
  iconPath: string;
  tray: Tray | undefined;
  announce: () => Promise<void>;
  finish: (target: BrowserWindow | undefined) => void;
  failed: () => void;
}

/** Windows SIGTERM kills only the guardian. Finish its owned tree before starting NSIS. */
function stopController(child: ChildProcessWithoutNullStreams) {
  if (process.platform === "win32" && child.pid)
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
}

/** Keep status visible until the guardian exits, with the existing cleanup deadline. */
export function shutdownDesktop(options: ShutdownOptions): BrowserWindow | undefined {
  const { controller } = options;
  let target: BrowserWindow | undefined;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    options.finish(target);
  };

  // EOF makes the guardian stop owned process groups even if Electron subsequently crashes.
  void options
    .announce()
    .catch(() => {})
    .finally(() => controller?.stdin.end());

  if (
    !controller ||
    options.controllerExited ||
    !controller.pid ||
    controller.exitCode !== null ||
    controller.signalCode !== null
  ) {
    // A second app.quit() must run after the cancelled before-quit handler has returned.
    queueMicrotask(finish);

    return undefined;
  }

  const timeout = setTimeout(() => stopController(controller), 35_000);
  controller.once("exit", () => {
    clearTimeout(timeout);
    finish();
  });
  target = createShutdownWindow(options.iconPath, options.installingUpdate, options.tray, options.failed);

  return target;
}
