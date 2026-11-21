import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { DocumentPolicy } from "../src/document-policy.ts";
import { isTrustedDesktopEvent } from "../src/desktop-window.ts";
import { initialStatus } from "../src/runtime/config.ts";
import { DesktopWebSession } from "../src/web-session.ts";
import { registerAppearanceIpc, windowAppearance, windowColors } from "../src/window-appearance.ts";

const directory = process.env["CANOPY_TEST_DESKTOP"]!;
const origin = process.env["CANOPY_TEST_ORIGIN"]!;
const scheme = process.env["CANOPY_TEST_APPEARANCE"]!;
const system = process.env["CANOPY_TEST_SYSTEM_SCHEME"]!;
const profile = join(directory, `${scheme}-${system}`);
const cache = join(profile, "appearance-cache.json");
const saved = JSON.stringify({ scheme, light: "fern", dark: "heather" });
const expected = (scheme === "system" ? system : scheme) === "dark" ? "rgb(27, 18, 35)" : "rgb(251, 254, 249)";

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
    webPreferences: { preload: join(directory, "preload.cjs"), contextIsolation: true, sandbox: true },
  });

  const appearanceWritten = Promise.withResolvers<void>();
  registerAppearanceIpc((event) => {
    assert.ok(isTrustedDesktopEvent(event, [target], origin, origin));

    if (!("returnValue" in event)) appearanceWritten.resolve();
  });
  ipcMain.handle("canopy:status", () => ({ ...initialStatus(), mode: "local", phase: "starting" }));
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

    for (const path of ["/desktop", "/desktop/migration"]) {
      await target.loadURL(origin + path);

      assert.equal(
        await target.webContents.executeJavaScript("getComputedStyle(document.documentElement).backgroundColor"),
        expected,
        path,
      );
    }
  } finally {
    target.destroy();
  }
}

void smoke().then(
  () => app.exit(0),
  (error: Error) => {
    console.error(error);
    app.exit(1);
  },
);
