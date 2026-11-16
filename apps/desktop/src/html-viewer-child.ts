import { app } from "electron";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

/** A separate Electron browser process lets DNS restrictions cover all of its frame processes. */
export function spawnViewer() {
  const directory = mkdtempSync(join(app.getPath("temp"), "canopy-agent-html-"));
  const environment: NodeJS.ProcessEnv = {};

  // Only OS/display configuration; no Canopy credentials, Node options or app configuration.
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "WINDIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "LANG",
    "LC_ALL",
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key];

  const child = spawn(
    process.execPath,
    [
      ...(process.defaultApp ? [app.getAppPath()] : []),
      ...["ozone-platform", "headless", "disable-gpu", "disable-gpu-compositing"].flatMap((flag) =>
        app.commandLine.hasSwitch(flag) ? [`--${flag}=${app.commandLine.getSwitchValue(flag)}`] : [],
      ),
      "--canopy-agent-html-viewer",
      `--canopy-html-profile=${directory}`,
    ],
    { env: environment, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" },
  );

  const cleaned = new Promise<void>((resolve) => {
    const cleanup = () => {
      // Chromium subprocesses can finish writing after their browser has exited.
      void rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        .catch(() => console.error("Couldn't remove the HTML viewer's temporary profile."))
        .then(resolve);
    };

    child.once("exit", cleanup);
    child.once("error", cleanup);
  });

  return { child, cleaned };
}
