import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { packThemeColors } from "@canopy/ui/theme-builder";
import { DocumentPolicy } from "../src/document-policy.ts";
import { isTrustedDesktopEvent } from "../src/desktop-window.ts";
import { initialStatus } from "../src/runtime/config.ts";
import { desktopVersionArgument } from "../src/startup-version.ts";
import { DesktopWebSession } from "../src/web-session.ts";
import { registerAppearanceIpc, windowAppearance, windowColors } from "../src/window-appearance.ts";

const directory = process.env["CANOPY_TEST_DESKTOP"]!;
const origin = process.env["CANOPY_TEST_ORIGIN"]!;
const scheme = process.env["CANOPY_TEST_APPEARANCE"]!;
const system = process.env["CANOPY_TEST_SYSTEM_SCHEME"]!;
const version = process.env["CANOPY_TEST_DESKTOP_VERSION"] ?? "";
const profile = join(directory, `${scheme}-${system}`);
const cache = join(profile, "appearance-cache.json");
const base = { scheme, light: "fern", dark: "heather" };
const custom = process.env["CANOPY_TEST_CUSTOM_THEME"] === "1";
const dark = (scheme === "system" ? system : scheme) === "dark";
const lightCanvas = "#eff6fd";
const darkCanvas = "#161c28";

const saved = JSON.stringify({
  ...base,
  ...(custom && {
    lightAccent: "violet",
    darkAccent: "orange",
    lightColors: packThemeColors({ canvas: lightCanvas }),
    darkColors: packThemeColors({ canvas: darkCanvas }),
  }),
});

mkdirSync(profile);

app.setPath("userData", profile);

writeFileSync(cache, saved);

async function smoke() {
  const token = await new Promise<string>((resolve) => createInterface({ input: process.stdin }).once("line", resolve));
  await app.whenReady();
  nativeTheme.themeSource = windowAppearance().scheme;

  const target = new BrowserWindow({
    show: false,
    backgroundColor: windowColors().canvas,
    webPreferences: {
      preload: join(directory, "preload.cjs"),
      additionalArguments: [desktopVersionArgument + version],
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (custom) {
    assert.equal(target.getBackgroundColor().toLowerCase(), dark ? darkCanvas : lightCanvas, "Native startup canvas");
    assert.equal(windowColors().accent, dark ? "#ffb86a" : "#7008e7", "Native startup accent");
  }

  const appearanceWritten = Promise.withResolvers<void>();
  registerAppearanceIpc((event) => {
    assert.ok(isTrustedDesktopEvent(event, [target], origin, origin));

    if (!("returnValue" in event)) appearanceWritten.resolve();
  });
  const starting = { ...initialStatus(), mode: "local", phase: "starting" } as const;
  const startupMounted = Promise.withResolvers<void>();
  const startupStatus = Promise.withResolvers<typeof starting>();
  ipcMain.handle("canopy:status", (event) => {
    if (event.senderFrame?.url !== origin + "/desktop") return starting;

    startupMounted.resolve();

    return startupStatus.promise;
  });
  ipcMain.handle("canopy:window-state", () => ({ zoomFactor: 1, fullscreen: false, maximized: false }));
  ipcMain.handle("canopy:enrollment-ready", () => undefined);
  ipcMain.handle("canopy:routes-ready", () => undefined);
  ipcMain.handle("canopy:updates", () => undefined);
  ipcMain.handle("canopy:app-update-history", () => []);
  ipcMain.handle("canopy:migration-status", () => ({ phase: "idle" }));

  const session = new DesktopWebSession(() => origin, token);
  session.attach(target.webContents.session, () => [target.webContents]);
  new DocumentPolicy(session).attach(target.webContents.session, () => [origin]);
  await target.loadURL("about:blank");
  const debuggerSession = target.webContents.debugger;
  debuggerSession.attach();

  // Media emulation exercises System without changing the host's appearance.
  await debuggerSession.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: system }],
  });

  try {
    await target.loadURL(origin + "/");
    await appearanceWritten.promise;
    assert.equal(readFileSync(cache, "utf8"), saved, "An offline reload must preserve the persisted desktop scheme");

    await Promise.all([target.loadURL(origin + "/desktop"), startupMounted.promise]);

    try {
      assert.equal(
        await target.webContents.executeJavaScript("document.querySelector('main [role=status]')?.textContent.trim()"),
        "Starting Canopy…",
      );
      assert.equal(
        await target.webContents.executeJavaScript("document.querySelector('main h1 + p')?.textContent"),
        version ? `Version ${version}` : undefined,
      );
      await assertPalette(target, "/desktop");
    } finally {
      startupStatus.resolve(starting);
    }

    await target.loadURL(origin + "/desktop/migration");
    await assertPalette(target, "/desktop/migration");

    if (custom) await assertOverrideUpdates(target);
  } finally {
    target.destroy();
  }
}

async function assertPalette(target: BrowserWindow, path: string) {
  const light = custom ? "rgb(239, 246, 253)" : "rgb(251, 254, 249)";
  const darkColor = custom ? "rgb(22, 28, 40)" : "rgb(27, 18, 35)";

  assert.equal(
    await target.webContents.executeJavaScript("getComputedStyle(document.documentElement).backgroundColor"),
    dark ? darkColor : light,
    path,
  );
}

async function assertOverrideUpdates(target: BrowserWindow) {
  const invalid = JSON.stringify({ ...base, lightColors: "00ab;cde" });
  assert.match(
    await target.webContents.executeJavaScript(
      `window.canopyDesktop.setAppearance(${invalid}).then(() => "", (error) => error.message)`,
    ),
    /Invalid appearance/,
  );
  assert.equal(readFileSync(cache, "utf8"), saved, "Invalid overrides must leave the startup cache intact");

  const cleared = JSON.stringify({ ...base, lightColors: "", darkColors: "" });
  await target.webContents.executeJavaScript(`window.canopyDesktop.setAppearance(${cleared})`);
  assert.equal(readFileSync(cache, "utf8"), JSON.stringify(base), "Clearing overrides must remove them from the cache");
  assert.equal(target.getBackgroundColor().toLowerCase(), dark ? "#1b1223" : "#fbfef9", "Restored native canvas");
}

void smoke().then(
  () => app.exit(0),
  (error: Error) => {
    console.error(error);
    app.exit(1);
  },
);
