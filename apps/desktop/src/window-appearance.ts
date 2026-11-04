import { app, BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent, type IpcMainEvent } from "electron";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isThemeName, paletteStyle, themeVariables } from "@canopy/ui/themes";
import type { DesktopAppearance } from "@canopy/ui/desktop";

interface AppearanceInput {
  scheme?: unknown;
  light?: unknown;
  dark?: unknown;
}

function isAppearance(value: AppearanceInput | null | undefined): value is DesktopAppearance {
  if (!value || typeof value !== "object" || !("scheme" in value) || !("light" in value) || !("dark" in value))
    return false;

  if (value.scheme !== "system" && value.scheme !== "light" && value.scheme !== "dark") return false;

  if (
    typeof value.light !== "string" ||
    typeof value.dark !== "string" ||
    !isThemeName(value.light) ||
    !isThemeName(value.dark)
  )
    return false;

  return true;
}

let cached: DesktopAppearance | undefined;

function path() {
  return join(app.getPath("userData"), "appearance-cache.json");
}

export function windowAppearance(): DesktopAppearance {
  if (!cached) {
    try {
      const value: AppearanceInput | null = JSON.parse(readFileSync(path(), "utf8"));

      if (isAppearance(value)) cached = value;
    } catch {
      /* Startup cache is optional; gateway settings replace it when the page is ready. */
    }
  }

  return cached ?? { scheme: "system", light: "birch", dark: "birch" };
}

export function windowColors() {
  const appearance = windowAppearance();
  const dark = appearance.scheme === "dark" || (appearance.scheme === "system" && nativeTheme.shouldUseDarkColors);

  return themeVariables(appearance[dark ? "dark" : "light"], dark ? "dark" : "light");
}

export function applyWindowAppearance(target: BrowserWindow) {
  nativeTheme.themeSource = windowAppearance().scheme;
  const colors = windowColors();
  target.setBackgroundColor(colors.canvas);

  if (process.platform === "win32" || process.platform === "linux")
    target.setTitleBarOverlay({ color: colors.canvas, symbolColor: colors.ink, height: 48 });
}

export function registerAppearanceIpc(authorize: (event: IpcMainInvokeEvent | IpcMainEvent) => void) {
  ipcMain.on("canopy:appearance-startup", (event) => {
    try {
      authorize(event);
      const appearance = windowAppearance();
      event.returnValue = { ...appearance, style: paletteStyle(appearance.light, appearance.dark) };
    } catch {
      event.returnValue = null;
    }
  });
  ipcMain.handle("canopy:appearance", (event, value: AppearanceInput | null) => {
    authorize(event);

    if (!isAppearance(value)) throw new Error("Invalid appearance");
    const next = { scheme: value.scheme, light: value.light, dark: value.dark };
    const before = windowAppearance();

    if (before.scheme === next.scheme && before.light === next.light && before.dark === next.dark) return;
    cached = next;

    try {
      writeFileSync(`${path()}.tmp`, JSON.stringify(next), { mode: 0o600 });
      renameSync(`${path()}.tmp`, path());
    } catch {
      /* A read-only startup cache must not prevent live chrome updates. */
    }

    for (const target of BrowserWindow.getAllWindows()) applyWindowAppearance(target);
  });
}
