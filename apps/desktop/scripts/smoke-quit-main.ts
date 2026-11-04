import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { QuitGuard } from "../src/quit-guard.ts";
import { initialStatus } from "../src/runtime/config.ts";
import { until } from "../src/runtime/process.ts";

const directory = process.env["CANOPY_QUIT_SMOKE_DIR"]!;

app.setPath("userData", join(directory, "data"));

function registerSmokeIpc(guard: QuitGuard, delivered: { phase: string; surface: string }[]) {
  ipcMain.on("canopy:quit-guard-delivered", (_event, phase: string, surface: string) =>
    delivered.push({ phase, surface }),
  );
  ipcMain.handle("canopy:status", () => initialStatus());
  ipcMain.handle("canopy:window-state", () => ({ zoomFactor: 1, fullscreen: false }));
  ipcMain.handle("canopy:quit-shortcut", () => guard.mode);
  ipcMain.handle("canopy:enrollment-ready", () => {});
  ipcMain.handle("canopy:updates", () => ({
    version: "smoke",
    buildChannel: "nightly",
    channel: "nightly",
    phase: "disabled",
    message: "Smoke check",
    changingChannel: false,
  }));
}

async function smoke() {
  await app.whenReady();
  const windows: BrowserWindow[] = [];
  const delivered: { phase: string; surface: string }[] = [];
  let quits = 0;

  const guard = new QuitGuard(
    "hold",
    {
      clock: {
        now: () => performance.now(),
        setTimeout: (callback, ms) => {
          const timer = setTimeout(callback, ms);

          return () => clearTimeout(timer);
        },
      },
      shortcut: "Ctrl+Q",
      repeatTiming: () => ({ initialDelayMs: 300, intervalMs: 50 }),
      quit: () => {
        quits++;
      },
      log: (decision) => console.info(`quit-guard ${decision}`),
      emit: (state) => {
        for (const target of windows) if (!target.isDestroyed()) target.webContents.send("canopy:quit-guard", state);
      },
    },
    "linux",
  );

  registerSmokeIpc(guard, delivered);

  for (const name of ["main", "settings"]) {
    const target = new BrowserWindow({
      width: 900,
      height: 600,
      webPreferences: {
        preload: join(directory, "preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    windows.push(target);
    target.webContents.on("console-message", (details) => {
      if (details.level === "error") console.error(`smoke renderer: ${details.message}`);
    });
    guard.attach(target);
    await target.loadURL(
      `data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'none'"><title>${name}</title><body>${name}</body>`,
    );
  }

  const target = windows[1]!;
  target.focus();
  await delay(100);

  const input = (repeat = false, type: "keyDown" | "keyUp" = "keyDown") =>
    target.webContents.sendInputEvent({
      type,
      keyCode: "q",
      modifiers: repeat ? ["control", "isautorepeat"] : ["control"],
    });

  input();
  input(false, "keyUp");
  await delay(1_100);
  assert.equal(quits, 0, "Hold tap must not quit");
  input();
  await delay(300);

  for (let i = 0; i < 16; i++) {
    input(true);
    await delay(50);
  }

  assert.equal(quits, 1, "Continuous repeats must complete Hold");
  input(false, "keyUp");

  guard.mode = "press-twice";
  await target.webContents.executeJavaScript(
    "window.quitSmokeLegacy = []; window.canopyDesktop.onQuitGuard(state => window.quitSmokeLegacy.push(state)); undefined",
  );
  input();
  input(false, "keyUp");
  await delay(550);
  assert.equal(quits, 1);
  assert.ok(
    delivered.some((event) => event.phase === "hint" && event.surface === "shell"),
    "Older web receives preload hint under strict CSP",
  );
  assert.equal(
    await target.webContents.executeJavaScript("window.quitSmokeLegacy.at(-1).phase"),
    "cancel",
    "Outdated overlays are hidden while the shell shows the correct hint",
  );

  for (const win of windows) {
    await win.webContents.executeJavaScript(
      "window.quitSmokeStates = []; window.canopyDesktop.onQuitGuard(state => window.quitSmokeStates.push(state), 1); undefined",
    );
    const phase = await win.webContents.executeJavaScript("window.quitSmokeStates.at(-1).phase");
    assert.equal(phase, "hint", "Both windows replay cached hint to a late overlay subscriber");
  }

  input();
  input(false, "keyUp"); // Slow second press re-arms.
  await delay(100);
  assert.equal(quits, 1);
  input(true);
  await delay(50);
  assert.equal(quits, 1, "A repeat must not count as second press");
  input();
  await delay(50);
  assert.equal(quits, 2, "Two real presses within 500 ms quit");
  guard.cancel();

  await checkProductionOverlay(windows, guard);
  console.info(
    "Electron quit smoke passed: Ctrl+Q, repeats, both windows, late subscription, strict-CSP shell fallback and production QuitGuardOverlay",
  );
}

async function checkProductionOverlay(windows: BrowserWindow[], guard: QuitGuard) {
  const target = windows[1]!;

  // Mount the actual production Svelte layout, including QuitGuardOverlay.
  for (const win of windows) {
    await win.loadURL(`${process.env["CANOPY_QUIT_SMOKE_WEB"]}/desktop`);
    await until(
      async () => await win.webContents.executeJavaScript("document.body.innerText.includes('Desktop shortcuts')"),
      5_000,
    );
  }

  target.focus();
  guard.press(false);
  await delay(550);

  for (const win of windows) {
    await until(
      async () =>
        await win.webContents.executeJavaScript("document.body.innerText.includes('Press Ctrl+Q twice to quit')"),
      5_000,
    );
  }

  const artifacts = process.env["CANOPY_QUIT_SMOKE_ARTIFACTS"];

  if (artifacts) mkdirSync(artifacts, { recursive: true });

  for (const dark of [false, true])
    for (const phone of [false, true]) {
      target.setSize(phone ? 390 : 900, phone ? 800 : 600);
      await target.webContents.executeJavaScript(`document.documentElement.classList.toggle('dark', ${dark})`);
      guard.cancel();
      guard.press(false);
      await delay(550);

      if (artifacts)
        writeFileSync(
          join(artifacts, `${dark ? "dark" : "light"}-${phone ? "phone" : "desktop"}-hint.png`),
          (await target.webContents.capturePage()).toPNG(),
        );
    }

  guard.cancel();
  guard.mode = "hold";
  guard.press(false);
  await delay(100);
  assert.ok(await target.webContents.executeJavaScript("document.body.innerText.includes('Keep holding…')"));

  if (artifacts)
    writeFileSync(join(artifacts, "dark-phone-hold.png"), (await target.webContents.capturePage()).toPNG());
  guard.release();
  await delay(400);
  assert.equal(await target.webContents.executeJavaScript("document.body.innerText.includes('Keep holding…')"), false);
}

void smoke().then(
  () => app.exit(0),
  (cause: unknown) => {
    console.error(cause);
    app.exit(1);
  },
);
