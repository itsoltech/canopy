import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, screen, session, type IpcMainEvent } from "electron";
import type { ActivityNotchItem } from "@canopy/ui/desktop";
import { ActivityNotch } from "../src/activity-notch.ts";
import { loadMacActivityNotchDisplay } from "../src/activity-notch-window.ts";
import { isTrustedDesktopEvent } from "../src/desktop-window.ts";
import { initialStatus, isString } from "../src/runtime/config.ts";
import type { ActivityNotchProbe } from "./activity-notch-probe.ts";

const route = "/threads/synthetic-activity";
const mac = process.platform === "darwin";
const working = { path: route, state: "working", title: "Synthetic private title" } as const;
const appPath = app.getAppPath();
const rowsChannel = "activity-notch-fixture:received-rows";
let stage = "starting Electron";

app.setPath("userData", join(appPath, "profile"));

function publish(window: BrowserWindow, items: readonly ActivityNotchItem[]) {
  return window.webContents.executeJavaScript(`window.canopyDesktop.setActivityNotch(${JSON.stringify(items)})`);
}

function showOverlay() {
  return new Promise<BrowserWindow>((resolve) => {
    app.once("browser-window-created", (_event, window) => window.once("show", () => resolve(window)));
  });
}

function receiveRows() {
  return new Promise<ActivityNotchProbe & { sender: IpcMainEvent["sender"] }>((resolve) => {
    ipcMain.once(rowsChannel, (event, probe: ActivityNotchProbe) => resolve({ ...probe, sender: event.sender }));
  });
}

function receiveHeight() {
  return new Promise<number>((resolve) => {
    ipcMain.once("activity-notch-fixture:received-height", (_event, height: number) => resolve(height));
  });
}

function assertDimension(name: string, actual: number, expected: number) {
  if (actual !== expected) console.log(`Activity notch ${name} expected ${expected} and got ${actual}`);
  assert.equal(actual, expected, name);
}

function assertNativeBounds(overlay: BrowserWindow, rows: number, headerHeight: number) {
  const { bounds, workArea } = screen.getPrimaryDisplay();
  const cutout = mac ? loadMacActivityNotchDisplay().primaryCutout() : undefined;
  const area = mac ? bounds : workArea;
  const center = bounds.x + (cutout?.center ?? bounds.width / 2);
  const native = overlay.getBounds();
  const compact = Math.max(200, cutout ? Math.ceil(cutout.width) + 2 : 0) + 80;
  const width = Math.min(area.width, (rows ? Math.max(480, compact) : compact) + 16);
  const height = headerHeight + (rows ? Math.min(rows, 7) * 32 + 8 : 0);
  const x = Math.min(area.x + area.width - width, Math.max(area.x, Math.round(center - width / 2)));

  assertDimension("top", native.y, mac ? bounds.y : workArea.y);
  assertDimension("left", native.x, x);
  assertDimension("width", native.width, width);
  assertDimension("height", native.height, Math.min(height, workArea.y + workArea.height - native.y));
  assert.equal(overlay.isFocused(), false);
}

async function toggleOverlay(overlay: BrowserWindow) {
  const [height] = await Promise.all([
    receiveHeight(),
    overlay.webContents.executeJavaScript(`document.querySelector('[aria-controls="activity-panel"]').click()`),
  ]);

  return height;
}

function waitForRow(window: BrowserWindow, state: ActivityNotchItem["state"]) {
  return window.webContents.executeJavaScript(`new Promise((resolve) => {
    const inspect = () => {
      const rows = Array.from(document.querySelectorAll('#activity-panel button'));
      if (!rows.some((row) => row.querySelector('[data-state=${state}]'))) return;
      observer.disconnect();
      resolve(rows.map((row) => row.getAttribute('aria-label')));
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.getElementById('activity-panel'), { subtree: true, childList: true, attributes: true });
    inspect();
  })`);
}

async function openOverlay(origin: string, source: BrowserWindow, settings: BrowserWindow) {
  const [overlay, first, headerHeight] = await Promise.all([
    showOverlay(),
    receiveRows(),
    receiveHeight(),
    publish(source, [working]),
  ]);

  assert.notEqual(overlay, source);
  assert.equal(overlay.isVisible(), true, "the overlay is shown while the source is unfocused");
  assert.equal(overlay.isAlwaysOnTop(), true, "the overlay is always on top");
  assert.equal(overlay.isFocusable(), false, "the overlay cannot take focus");
  assert.equal(overlay.isFocused(), false);
  assert.equal(source.isFocused(), false);
  assert.match(overlay.webContents.getURL(), /^data:text\/html/);
  assert.notEqual(overlay.webContents.session, source.webContents.session);
  assert.equal(first.sender, overlay.webContents);
  assert.equal(first.sandboxed, true);
  assert.equal(first.contextIsolated, true);
  const row = first.rows[0];
  assert.ok(row && Number.isSafeInteger(row.id));
  assert.deepEqual(first.rows, [{ id: row.id, kind: "Thread", number: 1, state: "working" }]);
  assert.deepEqual(await waitForRow(overlay, "working"), ["Open Thread 1, Working"]);

  await settings.loadURL(`${origin}/settings`);
  await assert.rejects(publish(settings, []), /Untrusted activity notch request/);
  await assert.rejects(
    publish(source, [{ ...working, path: `${route}?private=fixture` }]),
    /Invalid activity notch route/,
  );
  assert.equal(overlay.isVisible(), true, "rejected updates leave the overlay visible");

  const [updated] = await Promise.all([receiveRows(), publish(source, [{ ...working, state: "approval" }])]);
  assert.equal(updated.sender, overlay.webContents);
  assert.deepEqual(updated.rows, [{ id: row.id, kind: "Thread", number: 1, state: "approval" }]);
  assert.deepEqual(await waitForRow(overlay, "approval"), ["Open Thread 1, Needs approval"]);

  return { overlay, headerHeight };
}

async function checkGeometry(overlay: BrowserWindow, source: BrowserWindow, headerHeight: number) {
  const { bounds, workArea } = screen.getPrimaryDisplay();
  const cutout = mac ? loadMacActivityNotchDisplay().primaryCutout() : undefined;
  const topInset = mac ? Math.max(workArea.y - bounds.y, cutout?.height ?? 0) : 0;
  assertDimension("header height", headerHeight, Math.ceil(topInset || 32));
  assertNativeBounds(overlay, 0, headerHeight);

  stage = "expanding to one row";
  assert.equal(await toggleOverlay(overlay), headerHeight);
  assertNativeBounds(overlay, 1, headerHeight);

  stage = "expanding to the row limit";

  const extra = Array.from({ length: 9 }, (_, index): ActivityNotchItem => ({
    path: `/threads/synthetic-extra-${index}`,
    state: "working",
  }));

  const [cappedHeader] = await Promise.all([
    receiveHeight(),
    publish(source, [{ ...working, state: "approval" }, ...extra]),
  ]);

  assert.equal(cappedHeader, headerHeight);
  assertNativeBounds(overlay, 10, headerHeight);

  stage = "shrinking an open panel";
  const [shrunkHeader] = await Promise.all([receiveHeight(), publish(source, [{ ...working, state: "approval" }])]);
  assert.equal(shrunkHeader, headerHeight);
  assertNativeBounds(overlay, 1, headerHeight);
  assert.equal(await toggleOverlay(overlay), headerHeight);
  assertNativeBounds(overlay, 0, headerHeight);
}

async function smoke() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Activity fixture</title>");
  });

  try {
    await app.whenReady();
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    assert.ok(address && !isString(address));
    const origin = `http://127.0.0.1:${address.port}`;

    const createSource = () =>
      new BrowserWindow({
        show: false,
        webPreferences: { preload: join(appPath, "dist/preload.cjs"), contextIsolation: true, sandbox: true },
      });

    const source = createSource();
    const settings = createSource();
    ipcMain.on("canopy:appearance-startup", (event) => (event.returnValue = null));
    session.fromPartition("canopy-activity-notch").registerPreloadScript({
      type: "frame",
      filePath: join(appPath, "dist/activity-notch-probe.cjs"),
    });

    const opened = Promise.withResolvers<string>();
    const activity = new ActivityNotch(opened.resolve);
    const status = { ...initialStatus(), phase: "running", mode: "remote", webUrl: origin } as const;
    activity.statusChanged(status);
    activity.register((event) => {
      if (!isTrustedDesktopEvent(event, [source, settings], origin, origin))
        throw new Error("Untrusted desktop request");
    });
    activity.track(source);
    await source.loadURL(`${origin}/`);
    stage = "opening the overlay and checking ipc";
    const { overlay, headerHeight } = await openOverlay(origin, source, settings);

    stage = "checking compact geometry";
    await checkGeometry(overlay, source, headerHeight);

    // Both clicks run in the loaded renderer. DOM clicks cannot exercise native pointer delivery.
    stage = "opening a thread from the overlay";
    const hidden = once(overlay, "hide");
    await overlay.webContents.executeJavaScript(`
      document.querySelector('[aria-controls="activity-panel"]').click();
      document.querySelector('#activity-panel button').click();
    `);
    assert.equal(await opened.promise, route);
    await hidden;
    assert.equal(overlay.isVisible(), false);

    stage = "clearing activity";
    await Promise.all([once(overlay, "closed"), publish(source, [])]);
    assert.equal(overlay.isDestroyed(), true);
    stage = "switching the gateway";
    const [beforeTargetChange] = await Promise.all([showOverlay(), publish(source, [working])]);
    const changed = once(beforeTargetChange, "closed");
    activity.statusChanged({ ...status, gatewayUrl: "https://fixture.invalid" });
    await changed;
    await assert.rejects(publish(source, [working]), /Untrusted activity notch request/);
    assert.deepEqual(
      BrowserWindow.getAllWindows()
        .map((window) => window.id)
        .sort(),
      [source.id, settings.id].sort(),
    );

    stage = "closing the main window";
    await source.loadURL(`${origin}/fresh`);
    const [beforeSourceClose] = await Promise.all([showOverlay(), publish(source, [working])]);
    const closed = once(beforeSourceClose, "closed");
    source.close();
    await closed;
    assert.equal(source.isDestroyed(), true);
  } finally {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    server.closeAllConnections();

    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const watchdog = setTimeout(() => {
  console.log(`Activity notch timed out while ${stage}`);
  app.exit(1);
}, 25_000);

void smoke().then(
  () => {
    clearTimeout(watchdog);
    app.exit(0);
  },
  () => {
    clearTimeout(watchdog);
    console.log(`Activity notch failed while ${stage}`);
    app.exit(1);
  },
);
