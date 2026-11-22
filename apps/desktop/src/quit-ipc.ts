import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { QuitGuardState, QuitShortcut } from "@canopy/ui/desktop";
import { QuitGuard } from "./quit-guard.ts";
import { systemQuitClock, type KeyRepeatTiming } from "./quit-machine.ts";
import { isQuitShortcut, type QuitSettings } from "./quit-settings.ts";

export function createDesktopQuitGuard(
  mode: QuitShortcut,
  repeatTiming: () => KeyRepeatTiming | null,
  log: (decision: string) => void,
  emit: (state: QuitGuardState) => void,
) {
  return new QuitGuard(
    mode,
    {
      clock: systemQuitClock,
      shortcut: process.platform === "darwin" ? "⌘Q" : "Ctrl+Q",
      repeatTiming,
      quit: () => app.quit(),
      log,
      emit,
    },
    process.platform,
  );
}

export function registerQuitIpc(options: {
  guard: QuitGuard;
  settings: QuitSettings;
  authorize: (event: IpcMainInvokeEvent) => void;
  trusted: (event: IpcMainEvent) => boolean;
  surface: (event: IpcMainEvent) => "settings" | "main";
  log: (message: string) => void;
  changed: (value: QuitShortcut) => void;
}) {
  const { guard, settings, authorize, trusted, surface, log, changed } = options;
  ipcMain.handle("canopy:quit-shortcut", (event) => {
    authorize(event);

    return guard.mode;
  });
  ipcMain.on("canopy:quit-guard-delivered", (event, phase: QuitGuardState["phase"], rendered: "web" | "shell") => {
    if (
      !trusted(event) ||
      !["hint", "holding", "cancel"].includes(phase) ||
      (rendered !== "web" && rendered !== "shell")
    )
      return;
    log(`feedback phase=${phase} surface=${rendered} window=${surface(event)}`);
  });
  ipcMain.handle("canopy:set-quit-shortcut", (event, value: QuitShortcut) => {
    authorize(event);

    if (!isQuitShortcut(value)) throw new Error("Invalid quit shortcut");
    settings.write(value);
    guard.cancel();
    guard.mode = value;
    changed(value);

    return value;
  });
}
