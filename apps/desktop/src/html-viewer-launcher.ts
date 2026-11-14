import { app, ipcMain, nativeTheme, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema, Option } from "effect";
import { visualTheme } from "@canopy/domain/visuals";
import { ViewerInput } from "./html-viewer-input.ts";
import { windowAppearance } from "./window-appearance.ts";

const ViewerStatus = Schema.Literals(["ready", "opened", "error"]);

/** A separate Electron browser process lets DNS restrictions cover all of its frame processes. */
export function registerHtmlViewer(authorize: (event: IpcMainInvokeEvent) => void) {
  let viewer: ChildProcess | undefined;
  app.on("before-quit", () => viewer?.kill("SIGKILL"));
  ipcMain.handle("canopy:agent-html-open", async (event, specJson: string, title: string) => {
    authorize(event);
    const input = Schema.decodeUnknownSync(ViewerInput)({ specJson, title });
    const appearance = windowAppearance();

    const mode =
      appearance.scheme === "dark" || (appearance.scheme === "system" && nativeTheme.shouldUseDarkColors)
        ? "dark"
        : "light";

    const theme = visualTheme(appearance[mode], mode);
    viewer?.kill("SIGKILL");
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
      { env: environment, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );

    viewer = child;
    child.once("exit", () => {
      if (viewer === child) viewer = undefined;
      void rm(directory, { recursive: true, force: true });
    });
    child.once("error", () => {
      void rm(directory, { recursive: true, force: true });
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Couldn't open this visual."));
      }, 15000);

      const fail = () => {
        clearTimeout(timeout);
        reject(new Error("Couldn't open this visual."));
      };

      child.once("error", fail);
      child.once("exit", fail);
      child.on("message", (message) => {
        const status = Schema.decodeUnknownOption(ViewerStatus)(message);

        if (Option.isNone(status)) return;

        if (status.value === "ready") child.send({ ...input, theme });

        if (status.value === "opened") {
          clearTimeout(timeout);
          resolve();
        }

        if (status.value === "error") {
          child.kill("SIGKILL");
          fail();
        }
      });
    });
  });
}
