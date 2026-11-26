import { app, BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent, type IpcMainEvent } from "electron";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { paletteStyle, themeAccentNames, themeNames, themeVariables, type ThemeMode } from "@canopy/ui/themes";
import { unpackThemeColors } from "@canopy/ui/theme-builder";
import type { DesktopAppearance } from "@canopy/ui/desktop";

const themeName = Schema.Literals(themeNames);
const accent = Schema.optional(Schema.Literals(themeAccentNames));

const packedColors = Schema.optional(
  Schema.String.check(Schema.makeFilter((value) => unpackThemeColors(value) !== undefined)),
);

const appearanceInput = Schema.Struct({
  scheme: Schema.Literals(["system", "light", "dark"]),
  light: themeName,
  dark: themeName,
  lightAccent: accent,
  darkAccent: accent,
  lightColors: packedColors,
  darkColors: packedColors,
});

const decodeAppearance = Schema.decodeUnknownResult(appearanceInput);
const readAppearance = Schema.decodeUnknownSync(Schema.fromJsonString(appearanceInput));

let cached: DesktopAppearance | undefined;

function path() {
  return join(app.getPath("userData"), "appearance-cache.json");
}

export function windowAppearance(): DesktopAppearance {
  if (!cached) {
    try {
      cached = readAppearance(readFileSync(path(), "utf8"));
    } catch {
      /* The renderer applies its browser profile's preferences when the page is ready. */
    }
  }

  return cached ?? { scheme: "system", light: "birch", dark: "birch" };
}

function overridesFor(appearance: DesktopAppearance, mode: ThemeMode) {
  const colors = appearance[`${mode}Colors`];

  return { accent: appearance[`${mode}Accent`], colors: colors ? unpackThemeColors(colors) : undefined };
}

export function windowColors() {
  const appearance = windowAppearance();
  const dark = appearance.scheme === "dark" || (appearance.scheme === "system" && nativeTheme.shouldUseDarkColors);
  const mode = dark ? "dark" : "light";

  return themeVariables(appearance[mode], mode, overridesFor(appearance, mode));
}

export function applyWindowAppearance(target: BrowserWindow) {
  nativeTheme.themeSource = windowAppearance().scheme;
  target.setBackgroundColor(windowColors().canvas);
}

export function registerAppearanceIpc(authorize: (event: IpcMainInvokeEvent | IpcMainEvent) => void) {
  ipcMain.on("canopy:appearance-startup", (event) => {
    try {
      authorize(event);
      const appearance = windowAppearance();

      const style = paletteStyle(appearance.light, appearance.dark, {
        light: overridesFor(appearance, "light"),
        dark: overridesFor(appearance, "dark"),
      });

      event.returnValue = { ...appearance, style };
    } catch {
      event.returnValue = null;
    }
  });
  ipcMain.handle("canopy:appearance", (event, value) => {
    authorize(event);
    const decoded = decodeAppearance(value);

    if (decoded._tag === "Failure") throw new Error("Invalid appearance");

    const { lightColors, darkColors, ...preferences } = decoded.success;
    const next = { ...preferences, lightColors: lightColors || undefined, darkColors: darkColors || undefined };
    const before = windowAppearance();

    if (
      before.scheme === next.scheme &&
      before.light === next.light &&
      before.dark === next.dark &&
      before.lightAccent === next.lightAccent &&
      before.darkAccent === next.darkAccent &&
      before.lightColors === next.lightColors &&
      before.darkColors === next.darkColors
    )
      return;

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
