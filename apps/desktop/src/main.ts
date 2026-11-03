import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { DesktopStatus } from "@canopy/ui/desktop";
import { configuration, initialStatus, origin, serviceEnvironment } from "./runtime/config.ts";
import { loadSecrets } from "./vault.ts";
import { Logs } from "./runtime/log.ts";
import { desktopIdentity } from "./identity.ts";
import { DesktopUpdates } from "./updates.ts";

const identity = desktopIdentity();
app.setName(identity.productName);
app.setPath("userData", join(app.getPath("appData"), identity.productName));
if (process.platform === "win32") app.setAppUserModelId(identity.appId);
// Chromium does not recognize every Linux desktop (e.g. Hyprland). Select a real
// keychain backend explicitly instead of silently falling back to basic_text.
if (process.platform === "linux" && !app.commandLine.hasSwitch("password-store")) {
  app.commandLine.appendSwitch("password-store", /kde/i.test(process.env["XDG_CURRENT_DESKTOP"] ?? "") ? "kwallet6" : "gnome-libsecret");
}
if (process.env["CANOPY_USER_DATA"]) app.setPath("userData", resolve(process.env["CANOPY_USER_DATA"]));
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
let window: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let controller: ChildProcessWithoutNullStreams | undefined;
let controllerExited = false;
let setupOrigin = "";
let status = initialStatus();
let quitting = false;
let stopped = false;
let busy = false;
let installingUpdate = false;
const updates = new DesktopUpdates(broadcast, () => { installingUpdate = true; app.quit(); });
let sequence = 0;
let pendingLink: string | undefined;
const enrollmentReady = new Set<number>();
const requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build");
const iconPath = app.isPackaged ? join(resources, "icon.png") : resolve(app.getAppPath(), `build/${identity.channel}/icon.png`);
const logs = new Logs(join(app.getPath("userData"), "logs"));
const scriptHashes = new Map<string, Set<string>>();
async function preparePolicy(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!response.ok) throw new Error("The Canopy web address did not return an application page");
  const html = await response.text();
  const origin = new URL(url).origin;
  const hashes = scriptHashes.get(origin) ?? new Set<string>();
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) hashes.add(`'sha256-${createHash("sha256").update(match[1] ?? "").digest("base64")}'`);
  scriptHashes.set(origin, hashes);
}

function rpc(action: string, args: Record<string, unknown> = {}) {
  return new Promise<unknown>((resolveRequest, reject) => {
    if (!controller?.stdin.writable) { reject(new Error("Desktop services are unavailable; restart Canopy")); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error("Desktop operation timed out; see logs")); }, 180_000);
    requests.set(id, { resolve: resolveRequest, reject, timer });
    controller.stdin.write(JSON.stringify({ id, action, ...args }) + "\n");
  });
}
function isTrusted(event: IpcMainInvokeEvent, setupOnly = false) {
  const frame = event.senderFrame;
  if (!frame || event.sender.isDestroyed() || frame !== event.sender.mainFrame || ![window?.webContents, settingsWindow?.webContents].includes(event.sender)) return false;
  try {
    const url = new URL(frame.url);
    return setupOnly ? url.origin === setupOrigin && url.pathname === "/desktop" : url.origin === setupOrigin || url.origin === status.webUrl;
  } catch { return false; }
}
function authorize(event: IpcMainInvokeEvent, setupOnly = false) { if (!isTrusted(event, setupOnly)) throw new Error("Untrusted desktop request"); }
function broadcast() {
  for (const target of [window, settingsWindow]) if (target && !target.isDestroyed()) target.webContents.send("canopy:status", status);
  for (const target of [window, settingsWindow]) if (target && !target.isDestroyed()) target.webContents.send("canopy:updates", updates.status());
  const text = status.phase === "error" ? "Needs attention" : status.worker === "online" ? "Worker online" : status.phase === "starting" ? "Starting…" : "Worker offline";
  tray?.setToolTip(`${identity.productName} · ${text}`);
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: `${identity.productName} · ${text}`, enabled: false },
    { label: `Open ${identity.productName}`, click: showMain },
    { label: `CLIs: ${Object.entries(status.clis).filter(([, found]) => found).map(([name]) => name).join(", ") || "none found"}`, enabled: false },
    { label: "Desktop settings…", click: openSettings },
    updates.item(),
    { type: "separator" }, { label: `Quit ${identity.productName}`, click: () => app.quit() },
  ]));
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { label: identity.productName, submenu: [{ label: "Desktop settings…", accelerator: "CmdOrCtrl+,", click: openSettings }, updates.item(), { label: "Open logs folder", click: () => void shell.openPath(logs.directory) }, { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function external(url: string) {
  try { if (["https:", "http:", "mailto:"].includes(new URL(url).protocol)) void shell.openExternal(url); } catch { /* Invalid link. */ }
}
function showMain() {
  if (!setupOrigin || quitting) return;
  if (!window || window.isDestroyed()) {
    window = createWindow();
    void window.loadURL(status.phase === "running" && status.webUrl ? status.webUrl : `${setupOrigin}/desktop`);
  }
  window.show(); window.focus();
}
function createWindow() {
  const target = new BrowserWindow({ width: 1280, height: 850, minWidth: 760, minHeight: 560, title: identity.productName, icon: iconPath, show: false,
    ...(process.platform === "darwin" && { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 18 } }),
    webPreferences: { preload: join(app.getAppPath(), "dist/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false },
  });
  target.once("ready-to-show", () => target.show());
  target.on("page-title-updated", (event) => { event.preventDefault(); target.setTitle(identity.productName); });
  const contentId = target.webContents.id;
  target.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) enrollmentReady.delete(target.webContents.id);
  });
  target.on("closed", () => enrollmentReady.delete(contentId));
  target.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  target.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin === setupOrigin || parsed.origin === status.webUrl) return;
    } catch { /* Block malformed navigation. */ }
    event.preventDefault(); external(url);
  });
  target.webContents.on("will-redirect", (event, url) => {
    try { if ([setupOrigin, status.webUrl].includes(new URL(url).origin)) return; } catch { /* Block. */ }
    event.preventDefault(); external(url);
  });
  target.webContents.on("will-attach-webview", (event) => event.preventDefault());
  target.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.webContents.session.setPermissionCheckHandler(() => false);
  return target;
}
function openSettings() {
  if (!setupOrigin || quitting) return;
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  if (window && new URL(window.webContents.getURL() || setupOrigin).pathname === "/desktop") { window.show(); window.focus(); return; }
  settingsWindow = createWindow();
  settingsWindow.on("closed", () => { settingsWindow = undefined; });
  void settingsWindow.loadURL(`${setupOrigin}/desktop`);
}
function enrollment(link: string) {
  try {
    const url = new URL(link);
    if (url.protocol !== `${identity.scheme}:` || url.hostname !== "enroll" || link.length > 8192) return;
    const gatewayUrl = origin(url.searchParams.get("gateway"), "Gateway address");
    const webUrl = origin(url.searchParams.get("web"), "Web address");
    const enrollmentToken = url.searchParams.get("token") ?? "";
    if (enrollmentToken.length < 16 || enrollmentToken.length > 4096) return;
    pendingLink = link;
    if (!setupOrigin) return;
    openSettings();
    const target = settingsWindow ?? window;
    if (target && enrollmentReady.has(target.webContents.id)) {
      pendingLink = undefined;
      target.webContents.send("canopy:enrollment", { gatewayUrl, webUrl, enrollmentToken });
    }
  } catch { /* Never log deep links containing an enrollment secret. */ }
}
app.on("second-instance", (_event, argv) => { const link = argv.find((arg) => arg.startsWith(`${identity.scheme}://`)); if (link) enrollment(link); else showMain(); });
app.on("open-url", (event, url) => { event.preventDefault(); enrollment(url); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", showMain);
process.on("SIGTERM", () => app.quit());
process.on("SIGINT", () => app.quit());
app.on("before-quit", (event) => {
  if (stopped) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  updates.stop();
  const finish = () => { stopped = true; if (installingUpdate) updates.install(); else app.quit(); };
  // EOF makes the guardian stop owned process groups even if Electron subsequently crashes.
  controller?.stdin.end();
  const timeout = setTimeout(() => { controller?.kill("SIGTERM"); }, 35_000);
  if (!controller || controllerExited || !controller.pid || controller.exitCode !== null || controller.signalCode !== null) { clearTimeout(timeout); finish(); }
  else controller.once("exit", () => { clearTimeout(timeout); finish(); });
});

async function start() {
  const secrets = await loadSecrets(app.getPath("userData"));
  logs.protect(...Object.values(secrets));
  const runtime = join(resources, "runtime");
  const suffix = process.platform === "win32" ? ".exe" : "";
  const bun = join(runtime, `bun${suffix}`);
  controller = spawn(join(runtime, `canopy-controller${suffix}`), [], { stdio: "pipe", env: serviceEnvironment(), cwd: runtime, windowsHide: true });
  controller.stderr.on("data", logs.stream("controller"));
  createInterface({ input: controller.stdout }).on("line", (line) => {
    try {
      const message = JSON.parse(line) as { event?: string; status?: DesktopStatus; id?: number; result?: unknown; error?: string };
      if (message.event === "status" && message.status) { status = message.status; broadcast(); return; }
      if (message.id) {
        const request = requests.get(message.id);
        if (!request) return;
        requests.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
      }
    } catch { logs.write("controller", "Invalid controller message"); }
  });
  controller.on("error", (error) => logs.write("controller", error.message));
  controller.once("exit", () => {
    controllerExited = true;
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error("Desktop services stopped")); }
    requests.clear();
    if (!quitting) { status = { ...status, phase: "error", worker: "offline", error: "Desktop services stopped. Restart Canopy." }; broadcast(); }
  });
  const initialized = await rpc("initialize", { directory: app.getPath("userData"), secrets, paths: { bun, gateway: join(runtime, `canopy-gateway${suffix}`), worker: join(runtime, `canopy-worker${suffix}`), web: join(runtime, `canopy-web${suffix}`), postgres: join(runtime, "postgres"), compiled: true } }) as { origin: string; status: DesktopStatus };
  setupOrigin = initialized.origin;
  status = initialized.status;
  ipcMain.handle("canopy:status", (event) => { authorize(event); return status; });
  ipcMain.handle("canopy:settings", (event) => { authorize(event); openSettings(); });
  ipcMain.handle("canopy:updates", (event) => { authorize(event); return updates.status(); });
  ipcMain.handle("canopy:update-channel", (event, channel: unknown) => { authorize(event); return updates.setChannel(channel); });
  ipcMain.handle("canopy:update-check", (event) => { authorize(event); return updates.check(); });
  ipcMain.handle("canopy:update-install", (event) => { authorize(event); updates.restartIfReady(); });
  ipcMain.handle("canopy:enrollment-ready", (event) => {
    authorize(event, true);
    enrollmentReady.add(event.sender.id);
    if (pendingLink) enrollment(pendingLink);
  });
  ipcMain.handle("canopy:configure", async (event, raw: unknown) => {
    authorize(event, true);
    if (busy) throw new Error("Desktop configuration is already in progress");
    const config = configuration(raw);
    busy = true;
    try {
      if (config.mode === "remote" && config.enrollmentToken) logs.protect(config.enrollmentToken);
      await rpc("configure", { configuration: config });
      await preparePolicy(status.webUrl!);
      setTimeout(() => {
        if (!window || window.isDestroyed()) window = createWindow();
        void window.loadURL(status.webUrl!);
        settingsWindow?.close();
      }, 100);
    } finally { busy = false; }
  });
  window = createWindow();
  await preparePolicy(`${setupOrigin}/desktop`);
  let initialUrl = `${setupOrigin}/desktop`;
  if (status.phase === "running" && status.webUrl) {
    try { await preparePolicy(status.webUrl); initialUrl = status.webUrl; }
    catch { logs.write("desktop", "Web application unavailable; opening desktop settings while the worker reconnects"); }
  }
  // Only documents need these hooks. Unfiltered, every script, fetch and font would wait for a
  // round trip through this process (busy with menus and IPC) before reaching the network.
  const documents: Electron.WebRequestFilter = { urls: ["<all_urls>"], types: ["mainFrame"] };
  // Refresh hashes for every document (including reloading a nested SvelteKit route).
  window.webContents.session.webRequest.onBeforeRequest(documents, (details, callback) => {
    if (details.resourceType === "mainFrame" && [setupOrigin, status.webUrl].includes(new URL(details.url).origin)) {
      void preparePolicy(details.url).then(() => callback({})).catch(() => callback({ cancel: true }));
    } else callback({});
  });
  // Restrict executable code to the selected origin. Svelte needs inline style attributes; no eval.
  window.webContents.session.webRequest.onHeadersReceived(documents, (details, callback) => {
    let headers = details.responseHeaders;
    if (details.resourceType === "mainFrame" && [setupOrigin, status.webUrl].includes(new URL(details.url).origin)) {
      const hashes = [...(scriptHashes.get(new URL(details.url).origin) ?? [])].join(" ");
      headers = { ...headers, "Content-Security-Policy": [`default-src 'self'; script-src 'self' ${hashes}; style-src 'self' 'unsafe-inline' https://rsms.me; font-src 'self' https://rsms.me data:; img-src 'self' data: blob: https:; media-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'`] };
    }
    callback(headers ? { responseHeaders: headers } : {});
  });
  const image = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(image);
  tray.on("click", showMain);
  app.setAsDefaultProtocolClient(identity.scheme);
  void updates.start();
  broadcast();
  await window.loadURL(initialUrl);
  const link = pendingLink ?? process.argv.find((arg) => arg.startsWith(`${identity.scheme}://`));
  if (link) { pendingLink = undefined; enrollment(link); }
}
if (ownsInstance) void app.whenReady().then(start).catch((error: unknown) => {
  const message = logs.redact(error instanceof Error ? error.message : "Canopy startup failed");
  logs.write("desktop", message);
  dialog.showErrorBox("Canopy could not start", message);
  app.quit();
});
