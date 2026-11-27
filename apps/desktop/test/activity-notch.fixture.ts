import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, screen, session, type IpcMainEvent } from "electron";
import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { activityNotchLogoSize, type ActivityNotchItem } from "@canopy/ui/desktop";
import { activityNotchSnapshot } from "../../web/src/lib/features/desktop/activity-notch.ts";
import type { ActivityNotchLayout } from "../src/activity-notch-geometry.ts";
import { ActivityNotch, type ActivityNotchRow } from "../src/activity-notch.ts";
import { loadMacActivityNotchDisplay } from "../src/activity-notch-window.ts";
import { isTrustedDesktopEvent } from "../src/desktop-window.ts";
import { initialStatus, isString } from "../src/runtime/config.ts";
import type { ActivityNotchProbe } from "./activity-notch-probe.ts";

const route = "/threads/synthetic-activity";
const mac = process.platform === "darwin";
const working = { path: route, state: "working", title: "Restore focus" } as const;
const rgba = [38, 128, 198, 255];

const logoMark = {
  initials: "NB",
  foreground: "#f1f2f3",
  background: "#204060",
  pixels: Buffer.alloc(activityNotchLogoSize ** 2 * 4, Buffer.from(rgba)).toString("base64"),
};

const unredactedMark = { ...logoMark, logoUrl: "https://fixture.invalid/logo", projectId: "synthetic-id" };
const noMark = { initials: undefined, logo: undefined };
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

function receiveLayout(overlay: BrowserWindow) {
  const previousHeight = overlay.getBounds().height;
  const channel = "activity-notch-fixture:received-layout";

  return new Promise<{ layout: ActivityNotchLayout }>((resolve) => {
    const receive = (event: IpcMainEvent, layout: ActivityNotchLayout) => {
      if (event.sender !== overlay.webContents || layout.height === previousHeight) return;
      ipcMain.off(channel, receive);
      resolve({ layout });
    };

    ipcMain.on(channel, receive);
  });
}

function waitForNativeSize(overlay: BrowserWindow, layout: ActivityNotchLayout) {
  return new Promise<void>((resolve) => {
    const inspect = () => {
      if (overlay.getBounds().height !== layout.height) return;
      overlay.off("resize", inspect);
      resolve();
    };

    overlay.on("resize", inspect);
    inspect();
  });
}

function assertDimension(name: string, actual: number, expected: number) {
  if (actual !== expected) console.log(`Activity notch ${name} expected ${expected} and got ${actual}`);
  assert.equal(actual, expected, name);
}

async function assertHeaderFillsBand(overlay: BrowserWindow, height: number) {
  const rendered: number = await overlay.webContents.executeJavaScript(
    `document.querySelector('[aria-controls="activity-panel"]').getBoundingClientRect().height`,
  );

  assertDimension("rendered header height", rendered, height);
}

function assertNativeBounds(overlay: BrowserWindow, rows: number, headerHeight: number) {
  const { bounds, workArea } = screen.getPrimaryDisplay();
  const cutout = mac ? loadMacActivityNotchDisplay().primaryCutout() : undefined;
  const area = mac ? bounds : workArea;
  const center = bounds.x + (cutout?.center ?? bounds.width / 2);
  const native = overlay.getBounds();
  const compact = Math.max(200, cutout ? Math.ceil(cutout.width) + 2 : 0) + 80;
  // The window keeps the open panel's left edge and width, so the notch never shifts sideways.
  const width = Math.min(area.width, Math.max(480, compact) + 16);
  const height = headerHeight + (rows ? Math.min(rows, 5) * 72 + 8 : 0);
  const x = Math.min(area.x + area.width - width, Math.max(area.x, Math.round(center - width / 2)));

  assertDimension("top", native.y, mac ? bounds.y : workArea.y);
  assertDimension("left", native.x, x);
  assertDimension("width", native.width, width);
  assertDimension("height", native.height, Math.min(height, workArea.y + workArea.height - native.y));
  assert.equal(overlay.isFocused(), false);
}

async function toggleOverlay(overlay: BrowserWindow) {
  const [result] = await Promise.all([
    receiveLayout(overlay),
    overlay.webContents.executeJavaScript(`document.querySelector('[aria-controls="activity-panel"]').click()`),
  ]);

  await waitForNativeSize(overlay, result.layout);

  return result;
}

interface RenderedActivityRow {
  initials: string | undefined;
  logo: { width: number; height: number; rgba: number[] } | undefined;
}

function waitForRows(window: BrowserWindow, expectedLabels: readonly string[]): Promise<RenderedActivityRow[]> {
  return window.webContents.executeJavaScript(`new Promise((resolve) => {
    const inspect = () => {
      const rows = Array.from(document.querySelectorAll('#activity-panel button'));
      const labels = rows.map((row) => row.getAttribute('aria-label'));
      if (JSON.stringify(labels) !== JSON.stringify(${JSON.stringify(expectedLabels)})) return;
      observer.disconnect();
      resolve(rows.map((row) => {
        const mark = row.querySelector('.row-mark:not([hidden])');
        const canvas = mark?.querySelector('canvas');
        if (!canvas) return { initials: mark?.textContent || undefined, logo: undefined };
        return {
          initials: undefined,
          logo: {
            width: canvas.width,
            height: canvas.height,
            rgba: Array.from(canvas.getContext('2d').getImageData(0, 0, 1, 1).data),
          },
        };
      }));
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.getElementById('activity-panel'), { subtree: true, childList: true, attributes: true });
    inspect();
  })`);
}

async function publishRows(overlay: BrowserWindow, source: BrowserWindow, items: readonly ActivityNotchItem[]) {
  const [update] = await Promise.all([receiveRows(), publish(source, items)]);
  assert.equal(update.sender, overlay.webContents);

  return update.rows;
}

function botItem(name: string, color: string) {
  const bot = create(bots.BotSchema, {
    id: "synthetic-activity",
    configuration: { name, color, shape: "diamond" },
    unreadCount: 1,
  });

  const { items } = activityNotchSnapshot({
    threads: undefined,
    bots: [bot],
    computers: new Map(),
    staleBotHomes: new Set(),
    botExecuting: () => false,
    markForProject: () => undefined,
    projectOf: () => undefined,
    workerOf: () => undefined,
    now: 0,
  });

  const item = items[0];
  assert.ok(item);

  return item;
}

async function mascotBodyColor(overlay: BrowserWindow, expectedImage: string): Promise<number[]> {
  return overlay.webContents.executeJavaScript(`(async () => {
    const panel = document.getElementById("activity-panel");
    const image = await new Promise((resolve) => {
      const inspect = () => {
        const avatar = panel.querySelector(".row-mark img");
        if (avatar?.getAttribute("src") !== ${JSON.stringify(expectedImage)}) return;
        observer.disconnect();
        resolve(avatar);
      };
      const observer = new MutationObserver(inspect);
      observer.observe(panel, { subtree: true, childList: true, attributes: true });
      inspect();
    });
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 40;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, 40, 40);
    // The top of the chosen diamond is above the body of the generated capsule for this fixture ID.
    return Array.from(context.getImageData(20, 9, 1, 1).data);
  })()`);
}

async function checkProjectMarks(overlay: BrowserWindow, source: BrowserWindow, workingRow: ActivityNotchRow) {
  stage = "rendering a project logo and preserving other statuses";
  await toggleOverlay(overlay);

  const invalidColor = {
    path: "/threads/synthetic-malformed-mark",
    state: "approval",
    projectMark: { ...logoMark, foreground: "url(https://fixture.invalid/mark)" },
  } as const;

  const botName = "Release <bot>";
  const bot = { ...botItem(botName, "#12abef"), projectMark: logoMark };

  const markedThread = { ...working, projectMark: unredactedMark };
  const rows = await publishRows(overlay, source, [markedThread, invalidColor, bot]);
  const [, approvalRow, botRow] = rows;
  assert.ok(approvalRow && Number.isSafeInteger(approvalRow.id));
  assert.ok(botRow?.botMascot && Number.isSafeInteger(botRow.id));

  const otherRows: readonly ActivityNotchRow[] = [
    { id: approvalRow.id, label: "Untitled thread", state: "approval" },
    { id: botRow.id, label: botName, state: "completed", botMascot: botRow.botMascot },
  ];

  assert.deepEqual(rows, [{ ...workingRow, projectMark: logoMark }, ...otherRows]);
  const approvalLabel = "Open Untitled thread, Needs approval";
  const otherLabels = [approvalLabel, `Open ${botName}, Completed`];
  const logo = { width: activityNotchLogoSize, height: activityNotchLogoSize, rgba };
  assert.deepEqual(await waitForRows(overlay, ["Open Restore focus, project NB, Working", ...otherLabels]), [
    { initials: undefined, logo },
    noMark,
    noMark,
  ]);
  assert.deepEqual(await mascotBodyColor(overlay, botRow.botMascot), [18, 171, 239, 255]);

  stage = "updating the project mark and falling back to initials";
  const initialsMark = { initials: "DN", foreground: "#cceeff", background: "#112233" };
  const invalidLogo = { ...initialsMark, pixels: `${logoMark.pixels.slice(0, -2)}--` };
  const changed = await publishRows(overlay, source, [{ ...working, projectMark: invalidLogo }, invalidColor, bot]);
  assert.deepEqual(changed, [{ ...workingRow, projectMark: initialsMark }, ...otherRows]);
  assert.deepEqual(await waitForRows(overlay, ["Open Restore focus, project DN, Working", ...otherLabels]), [
    { initials: "DN", logo: undefined },
    noMark,
    noMark,
  ]);

  stage = "removing the project mark without changing activity";
  const cleared = await publishRows(overlay, source, [working, invalidColor, bot]);
  assert.deepEqual(cleared, [workingRow, ...otherRows]);
  assert.deepEqual(await waitForRows(overlay, ["Open Restore focus, Working", ...otherLabels]), [
    noMark,
    noMark,
    noMark,
  ]);

  stage = "updating a bot name and mascot";
  const renamedBot = "Release coordinator for production rollouts and customer communications";
  const renamed = await publishRows(overlay, source, [working, invalidColor, botItem(renamedBot, "#12abef")]);
  assert.deepEqual(renamed, [workingRow, approvalRow, { ...botRow, label: renamedBot }]);
  const [, , recolored] = await publishRows(overlay, source, [working, invalidColor, botItem(renamedBot, "#fa5020")]);
  assert.equal(recolored?.id, botRow.id);
  assert.ok(recolored?.botMascot);
  await waitForRows(overlay, ["Open Restore focus, Working", approvalLabel, `Open ${renamedBot}, Completed`]);
  assert.deepEqual(await mascotBodyColor(overlay, recolored.botMascot), [250, 80, 32, 255]);
  await toggleOverlay(overlay);
}

async function checkPreloadRedaction(overlay: BrowserWindow) {
  stage = "checking the overlay preload redaction";
  const row = { id: 170, label: working.title, state: "answer" } as const;

  const projected = overlay.webContents.executeJavaScript(`new Promise((resolve) => {
    window.canopyActivityNotch.onRows((rows) => {
      if (rows[0]?.id === ${row.id}) resolve(rows);
    });
  })`);

  // Inject synthetic extra fields after main's projection to exercise the preload independently.
  overlay.webContents.send(
    "canopy:activity-notch-rows",
    [{ ...row, path: route, transcript: "Synthetic private content", projectMark: unredactedMark }],
    1,
  );
  assert.deepEqual(await projected, [{ ...row, projectMark: logoMark }]);
}

async function openOverlay(origin: string, source: BrowserWindow, settings: BrowserWindow) {
  const [overlay, first] = await Promise.all([showOverlay(), receiveRows(), publish(source, [working])]);

  assert.notEqual(overlay, source);
  assert.equal(overlay.isVisible(), true, "the overlay is shown while the source is focused");
  assert.equal(overlay.isAlwaysOnTop(), true, "the overlay is always on top");
  assert.equal(overlay.isFocusable(), false, "the overlay cannot take focus");
  assert.equal(overlay.isFocused(), false);
  assert.equal(source.isFocused(), true, "showing the overlay preserves the source's focus");
  assert.match(overlay.webContents.getURL(), /^data:text\/html/);
  assert.notEqual(overlay.webContents.session, source.webContents.session);
  assert.equal(first.sender, overlay.webContents);
  assert.equal(first.sandboxed, true);
  assert.equal(first.contextIsolated, true);
  const row = first.rows[0];
  assert.ok(row && Number.isSafeInteger(row.id));
  const workingRow = { id: row.id, label: working.title, state: "working" } as const;
  assert.deepEqual(first.rows, [workingRow]);
  assert.deepEqual(await waitForRows(overlay, ["Open Restore focus, Working"]), [noMark]);

  await settings.loadURL(`${origin}/settings`);
  await assert.rejects(publish(settings, []), /Untrusted activity notch request/);
  await assert.rejects(
    publish(source, [{ ...working, path: `${route}?private=fixture` }]),
    /Invalid activity notch route/,
  );
  assert.equal(overlay.isVisible(), true, "rejected updates leave the overlay visible");

  await checkProjectMarks(overlay, source, workingRow);

  stage = "updating the thread title";
  const renamed = { ...working, title: "Review <desktop> & restore focus" };
  const titled = await publishRows(overlay, source, [renamed]);
  assert.deepEqual(titled, [{ ...workingRow, label: renamed.title }]);
  await waitForRows(overlay, ["Open Review <desktop> & restore focus, Working"]);

  const renderedTitle = await overlay.webContents.executeJavaScript(`(() => {
    const title = document.querySelector(".row .row-title");
    const label = title.querySelector(".swap-layer:not([data-leaving])");
    return { text: label.textContent, tooltip: title.title, children: label.childElementCount };
  })()`);

  assert.deepEqual(renderedTitle, { text: renamed.title, tooltip: renamed.title, children: 0 });

  stage = "updating the activity status";
  const updated = await publishRows(overlay, source, [{ ...working, state: "approval" }]);
  assert.deepEqual(updated, [{ ...workingRow, state: "approval" }]);
  await waitForRows(overlay, ["Open Restore focus, Needs approval"]);

  return overlay;
}

async function checkGeometry(overlay: BrowserWindow, source: BrowserWindow) {
  const headerHeight = overlay.getBounds().height;
  const { bounds, workArea } = screen.getPrimaryDisplay();
  const cutout = mac ? loadMacActivityNotchDisplay().primaryCutout() : undefined;
  const topInset = mac ? Math.max(workArea.y - bounds.y, cutout?.height ?? 0) : 0;

  if (mac) assertDimension("header height", headerHeight, Math.ceil(topInset || 32));
  else assert.ok(headerHeight >= 32, "the Windows header is at least the requested compact height");
  assertNativeBounds(overlay, 0, headerHeight);
  await assertHeaderFillsBand(overlay, headerHeight);

  stage = "expanding to one row";
  assert.equal((await toggleOverlay(overlay)).layout.headerHeight, headerHeight);
  assertNativeBounds(overlay, 1, headerHeight);
  await assertHeaderFillsBand(overlay, headerHeight);

  stage = "expanding to the row limit";

  const extra = Array.from({ length: 9 }, (_, index): ActivityNotchItem => ({
    path: `/threads/synthetic-extra-${index}`,
    state: "working",
  }));

  const [capped] = await Promise.all([
    receiveLayout(overlay),
    publish(source, [{ ...working, state: "approval" }, ...extra]),
  ]);

  assert.equal(capped.layout.headerHeight, headerHeight);
  assertNativeBounds(overlay, 10, headerHeight);

  stage = "shrinking an open panel";
  const [shrunk] = await Promise.all([receiveLayout(overlay), publish(source, [{ ...working, state: "approval" }])]);
  await waitForNativeSize(overlay, shrunk.layout);
  assert.equal(shrunk.layout.headerHeight, headerHeight);
  assertNativeBounds(overlay, 1, headerHeight);

  stage = "collapsing after the transition";
  const collapsed = await toggleOverlay(overlay);
  assert.equal(collapsed.layout.headerHeight, headerHeight);
  assertNativeBounds(overlay, 0, headerHeight);
  assert.equal(source.isFocused(), true, "toggling the overlay preserves the source's focus");
}

async function clearActivity(overlay: BrowserWindow, source: BrowserWindow) {
  const reducedMotion: boolean = await overlay.webContents.executeJavaScript(
    `matchMedia("(prefers-reduced-motion: reduce)").matches`,
  );

  if (!reducedMotion) {
    await overlay.webContents.executeJavaScript(`{
      const notch = document.querySelector('.notch');
      window.pausedFade = new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (notch.hasAttribute('data-active')) return;
          observer.disconnect();
          const fade = notch.getAnimations().find((animation) => animation.transitionProperty === 'opacity');
          fade?.pause();
          resolve(Boolean(fade));
        });
        observer.observe(notch, { attributeFilter: ['data-active'] });
      });
    }`);

    assert.deepEqual(await publishRows(overlay, source, []), []);
    assert.equal(await overlay.webContents.executeJavaScript("window.pausedFade"), true);
    assert.equal(overlay.isVisible(), true, "the native window stays visible during its fade");

    await Promise.all([once(ipcMain, "canopy:activity-notch-hidden"), publishRows(overlay, source, [working])]);
    assert.equal(overlay.isDestroyed(), false, "the old fade cannot close a window with new activity");
  }

  await Promise.all([once(overlay, "closed"), publish(source, [])]);
  assert.equal(overlay.isDestroyed(), true);
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
    stage = "focusing the source window";
    const focused = once(source, "focus");
    source.show();
    await focused;
    stage = "opening the overlay and checking ipc";
    const overlay = await openOverlay(origin, source, settings);

    stage = "checking compact geometry";
    await checkGeometry(overlay, source);

    stage = "switching focus between windows";
    const blurred = once(source, "blur");
    settings.show();
    await blurred;
    assert.equal(overlay.isVisible(), true);

    const refocused = once(source, "focus");
    source.focus();
    await refocused;
    assert.equal(overlay.isVisible(), true);

    // DOM clicks cannot exercise native pointer delivery.
    stage = "opening a thread from the overlay";
    const { layout } = await toggleOverlay(overlay);

    const [afterOpen] = await Promise.all([
      receiveLayout(overlay),
      overlay.webContents.executeJavaScript(`document.querySelector('#activity-panel button').click()`),
    ]);

    await waitForNativeSize(overlay, afterOpen.layout);
    assert.equal(await opened.promise, route);
    assert.equal(overlay.isVisible(), true);
    assertNativeBounds(overlay, 0, layout.headerHeight);

    stage = "clearing activity";
    await clearActivity(overlay, source);
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

    stage = "opening the overlay for a fresh source";
    await source.loadURL(`${origin}/fresh`);
    const [beforeSourceClose] = await Promise.all([showOverlay(), publish(source, [working])]);
    await checkPreloadRedaction(beforeSourceClose);
    stage = "closing the main window";
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
