import { app, BrowserWindow, ipcMain, nativeImage, powerMonitor, Tray } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { monitorPower } from "./power-events.ts";
import { registerWorkspaceClose, requestWorkspaceQuit } from "./workspace-close.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { initialStatus, serviceEnvironment } from "./runtime/config.ts";
import { desktopLink } from "./desktop-link.ts";
import { holdConnectorOAuth, registerConnectorOAuthIpc } from "./connector-oauth-ipc.ts";
import type { ControllerArguments, ControllerResult } from "./controller.ts";
import { ControllerConnection } from "./controller-connection.ts";
import { initializeController } from "./controller-initialize.ts";
import { savedRemoteClient } from "./client-vault.ts";
import { closeModeChooser, ConfigurationLock, openModeChooser, registerModeIpc } from "./mode-configuration.ts";
import { Logs } from "./runtime/log.ts";
import { controllerEntry, runtimePaths } from "./runtime/launch.ts";
import { desktopIdentity, desktopUserData } from "./identity.ts";
import { DesktopUpdates } from "./updates.ts";
import { quitKeyEvent } from "./quit-key-event.ts";
import { createDesktopQuitGuard, registerQuitIpc } from "./quit-ipc.ts";
import { QuitSettings } from "./quit-settings.ts";
import { registerWindowPreferencesIpc } from "./window-chrome.ts";
import { updateDesktopMenus } from "./desktop-menu.ts";
import { AppRoutes } from "./app-routes.ts";
import { registerAppRouteIpc, showAppRoute } from "./app-route-ipc.ts";
import { createDesktopWindow, isTrustedDesktopEvent, windowSizeLimits } from "./desktop-window.ts";
import { registerHtmlViewer } from "./html-viewer-launcher.ts";
import { windowPlacement } from "./window-state.ts";
import { DocumentPolicy } from "./document-policy.ts";
import { DesktopWebSession } from "./web-session.ts";
import type { RemoteAppUpdate } from "./remote-app-update.ts";
import { acceptRemoteUpdate, remoteAppUpdate, registerUpdateIpc } from "./update-ipc.ts";
import { desktopHistory, registerHistoryIpc } from "./history-ipc.ts";
import { registerFontsIpc } from "./fonts-ipc.ts";
import { startupFailure } from "./startup-error.ts";
import { sendWindowMessage, sendWindowsMessage, windowContents } from "./window-message.ts";
import { relaunchAfterQuit } from "./relaunch.ts";
import { configureDesktopApplication, registerDesktopLifecycle } from "./desktop-lifecycle.ts";
import { desktopResourcePaths } from "./desktop-resources.ts";
import { showShutdownWindow } from "./shutdown-window.ts";
import { shutdownDesktop } from "./shutdown.ts";
import { PreviewWindows } from "./preview-windows.ts";
import { registerMigrationIpc } from "./migration-ipc.ts";
import { DesktopUsagePing } from "./usage-ping.ts";
import { NotificationBadge } from "./notification-badge.ts";
import { ActivityNotch } from "./activity-notch.ts";
import { activityNotchPlacementFile } from "./activity-notch-placement.ts";

const identity = desktopIdentity();

// Electron also uses this name for Keychain / Secret Service encryption keys.
app.setName(identity.productName);

app.setPath("userData", desktopUserData(app.getPath("appData")));

const ownsInstance = configureDesktopApplication(identity);

let window: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let shutdownWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let controller: ChildProcessWithoutNullStreams | undefined;
let controllerExited = false;
let setupOrigin = "";
let status = initialStatus();
let quitting = false;
let stopped = false;
let stopPower = () => {};
let startupError = "";

let remoteUpdate: RemoteAppUpdate | undefined;

let connection: ControllerConnection | undefined;
let pendingLink: string | undefined;
const enrollmentReady = new Set<number>();

const { iconPath, runtime } = desktopResourcePaths();

const logs = new Logs(join(app.getPath("userData"), "logs"));
const updates = new DesktopUpdates(broadcast, logs);
const startupFailed = startupFailure(logs, () => quitting);
const history = desktopHistory();
const configurationLock = new ConfigurationLock();
const quitSettings = new QuitSettings(app.getPath("userData"));
const usagePing = new DesktopUsagePing(app.getPath("userData"));
const notificationBadge = new NotificationBadge();
const activityNotch = new ActivityNotch(openRoute, activityNotchPlacementFile(app.getPath("userData")));
const quitLog = (decision: string) => logs.write("desktop", `quit-guard ${decision}`);
const quitKey = quitKeyEvent(quitLog);

const quitGuard = createDesktopQuitGuard(quitSettings.read(), quitKey.timing, quitLog, (state) =>
  sendWindowsMessage([window, settingsWindow], (contents) => contents.send("canopy:quit-guard", state)),
);

const webSession = new DesktopWebSession(() => setupOrigin);
const policy = new DocumentPolicy(webSession);
const appRoutes = new AppRoutes();
const previews = new PreviewWindows(iconPath, quitGuard, () => openRoute("/settings/agent-tools"));
const appContents = () => [windowContents(window), windowContents(settingsWindow), ...previews.contents()];

function rpc(action: string, args: ControllerArguments = {}) {
  return connection
    ? connection.request(action, args)
    : Promise.reject<ControllerResult>(new Error("Desktop services are unavailable; restart Canopy"));
}

const isTrusted = (event: IpcMainInvokeEvent | IpcMainEvent, setupOnly = false) =>
  !quitting &&
  !controllerExited &&
  isTrustedDesktopEvent(event, [window, settingsWindow], setupOrigin, status.webUrl, setupOnly);

function authorize(event: IpcMainInvokeEvent | IpcMainEvent, setupOnly = false) {
  if (!isTrusted(event, setupOnly)) throw new Error("Untrusted desktop request");
}

function broadcast() {
  if (quitting) return;
  notificationBadge.statusChanged(status);
  activityNotch.statusChanged(status);
  remoteUpdate?.changed();

  if (remoteUpdate && !remoteUpdate.active) void remoteUpdate.publish().catch(() => {});

  sendWindowsMessage([window, settingsWindow], (contents) => contents.send("canopy:status", status));
  sendWindowsMessage([window, settingsWindow], (contents) => contents.send("canopy:updates", updates.status()));

  updateDesktopMenus({
    status,
    tray,
    productName: identity.displayName,
    showMain,
    openSettings,
    openAppSettings: (keyboard) => openRoute("/settings", keyboard),
    updates,
    quitGuard,
    quitKey,
    logsDirectory: logs.directory,
  });
}

function showMain() {
  if (quitting) return showShutdownWindow(shutdownWindow);

  if (!setupOrigin) return;

  if (!window || window.isDestroyed()) {
    window = createWindow(true);
    void window.loadURL(`${setupOrigin}/desktop`).then(() => {
      if (status.phase === "running") void openApplication();
    });

    return;
  }

  if (window.isMinimized()) window.restore();

  window.show();
  window.focus();
}

function createWindow(main = false) {
  const target = createDesktopWindow({
    appRoutes,
    placement: main ? windowPlacement(app.getPath("userData"), windowSizeLimits) : undefined,
    productName: identity.displayName,
    iconPath,
    quitGuard,
    enrollmentReady,
    quitting: () => quitting,
    setupOrigin: () => setupOrigin,
    webUrl: () => status.webUrl,
  });

  if (main) {
    target.on("focus", sendUsagePing);
    activityNotch.track(target);
  }

  return target;
}

function sendUsagePing() {
  if (!quitting && status.configuration) void usagePing.sendIfDue();
}

function openRoute(path: string, keyboard?: boolean) {
  if (status.phase === "running" && !quitting) showAppRoute(appRoutes, path, showMain, () => window, keyboard);
  else showMain();
}

function openSettings() {
  if (!setupOrigin || quitting) return;

  settingsWindow = openModeChooser({
    current: settingsWindow,
    create: () => createWindow(),
    origin: setupOrigin,
    closed: () => {
      settingsWindow = undefined;
    },
  });
}

async function openApplication() {
  if (!status.webUrl || quitting) return;

  try {
    await policy.prepare(status.webUrl);

    if (quitting) return;

    if (!window || window.isDestroyed()) window = createWindow(true);
    await window.loadURL(status.webUrl);

    if (quitting) return;
    settingsWindow?.close();
  } catch {
    if (quitting) return;
    previews.closeAll();
    startupError = "Gateway unavailable. Check your connection and the Canopy web address, then try again.";
    status = { ...status, phase: "error", error: startupError };
    logs.write("desktop", "Web application unavailable; showing startup recovery");
    broadcast();

    if (window && !window.isDestroyed() && window.webContents.getURL() !== `${setupOrigin}/desktop`)
      await window.loadURL(`${setupOrigin}/desktop`);
  }
}

function enrollment(link: string) {
  const parsed = desktopLink(link, identity.scheme);

  if (!parsed) return;
  pendingLink = link;

  if (!setupOrigin) return;

  if (parsed.connectors || parsed.oauth) {
    pendingLink = undefined;

    // Settings → Connectors takes the code over the desktop bridge and finishes sign-in in its gateway.
    if (parsed.oauth) holdConnectorOAuth(parsed.oauth);

    openRoute("/settings/connectors");

    return;
  }

  openSettings();
  const target = settingsWindow ?? window;

  sendWindowMessage(target, (contents) => {
    if (!enrollmentReady.has(contents.id)) return;
    pendingLink = undefined;
    contents.send("canopy:enrollment", parsed.enrollment);
  });
}

registerDesktopLifecycle(identity.scheme, () => quitting, showMain, enrollment, updates.requestQuit);

app.on("before-quit", (event) => {
  if (stopped) return;
  event.preventDefault();

  if (quitting) return;

  if (requestWorkspaceQuit()) return;
  quitting = true;
  notificationBadge.clear();
  activityNotch.clear();
  webSession.revoke(appContents());
  previews.closeAll();
  stopPower();
  quitGuard.cancel();

  for (const target of BrowserWindow.getAllWindows()) target.hide();
  updates.stop();
  remoteUpdate?.stop();

  shutdownWindow = shutdownDesktop({
    controller,
    controllerExited,
    installingUpdate: updates.installing,
    iconPath,
    tray,
    announce: async () => {
      await rpc("presence", {
        state: updates.installing ? "updating" : "shutting_down",
        targetVersion: updates.installing ? updates.status().updateVersion : undefined,
      });
    },
    finish: (target) => {
      stopped = true;
      target?.destroy();

      if (updates.installing) updates.install();
      else {
        relaunchAfterQuit();
        app.quit();
      }
    },
    failed: () => logs.write("desktop", "Could not load the closing status window"),
  });
});

function startController() {
  const paths = runtimePaths(runtime);
  controller = spawn(paths.bun, [controllerEntry(runtime)], {
    stdio: "pipe",
    env: { ...serviceEnvironment(), SSH_AUTH_SOCK: process.env["SSH_AUTH_SOCK"] },
    cwd: runtime,
    windowsHide: true,
  });
  connection = new ControllerConnection(
    controller,
    logs,
    (next) => {
      if (next.needsPairing && !status.needsPairing) void history.clear();
      previews.statusChanged(status, next);
      status = startupError ? { ...next, phase: "error", error: startupError } : next;
      broadcast();
    },
    () => {
      controllerExited = true;
      webSession.revoke(appContents());
      previews.closeAll();

      if (!quitting) {
        status = { ...status, phase: "error", worker: "offline", error: "Desktop services stopped. Restart Canopy." };
        broadcast();
      }
    },
    (command) => acceptRemoteUpdate(remoteUpdate, updates, command, logs),
  );

  return paths;
}

function registerIpc() {
  previews.register(
    authorize,
    () => windowContents(window),
    () => status,
  );
  registerHtmlViewer(authorize);
  registerFontsIpc(authorize, () => status.webUrl);
  registerHistoryIpc(history, authorize, () => status.phase === "running" && !status.needsPairing);
  registerWindowPreferencesIpc(authorize, iconPath);
  notificationBadge.register(authorize);
  activityNotch.register(authorize);
  registerWorkspaceClose(authorize);
  registerAppRouteIpc(appRoutes, authorize, () => window);
  registerQuitIpc({
    guard: quitGuard,
    settings: quitSettings,
    authorize,
    trusted: isTrusted,
    log: quitLog,
    surface: (event) => (event.sender === windowContents(settingsWindow) ? "settings" : "main"),
    changed: (value) =>
      sendWindowsMessage([window, settingsWindow], (contents) => contents.send("canopy:quit-shortcut", value)),
  });
  registerUpdateIpc(updates, () => remoteUpdate, authorize);
  usagePing.registerIpc(authorize, (event) => {
    if (event.sender === windowContents(window) && window?.isFocused()) sendUsagePing();
  });
  registerMigrationIpc({
    directory: app.getPath("userData"),
    origin: setupOrigin,
    rpc,
    authorize,
    avoidRestart: () => configurationLock.active || updates.installing || !!remoteUpdate?.active,
    onSwitch: async (client) => {
      activityNotch.invalidate();
      previews.closeAll();
      await history.clear();
      startupError = "";
      logs.protect(client.token);
      remoteUpdate?.selectDevice(client.deviceId);
      await remoteUpdate?.publish();
    },
  });
  registerConnectorOAuthIpc(authorize);
  ipcMain.handle("canopy:enrollment-ready", (event) => {
    authorize(event, true);
    enrollmentReady.add(event.sender.id);

    if (pendingLink) enrollment(pendingLink);
  });
  registerModeIpc(
    authorize,
    () => configurationLock.acquire(),
    () => rpc("migration-status"),
    () => ({
      status,
      directory: app.getPath("userData"),
      remoteUpdate,
      logs,
      openSettings,
      closeSettings: () => closeModeChooser(settingsWindow, window),
      apply: async (config, client) => {
        previews.closeAll();
        await history.clear();
        startupError = "";
        await rpc("configure", { configuration: config, remoteClient: client });
        notificationBadge.invalidate();
        activityNotch.invalidate();
        sendUsagePing();

        if (status.phase === "running") await openApplication();

        if (status.phase === "error") throw new Error(status.error ?? "Could not save desktop mode");
      },
    }),
  );
}

async function start() {
  stopPower = monitorPower(powerMonitor, async (state) => {
    await rpc("presence", { state });
  });
  const initialized = await initializeController(app.getPath("userData"), startController, webSession.token, rpc, logs);

  if (quitting) return;
  remoteUpdate = remoteAppUpdate(updates, rpc);
  await remoteUpdate.publish();

  if (quitting) return;

  setupOrigin = initialized.origin;
  status = initialized.status;
  sendUsagePing();
  registerIpc();
  window = createWindow(true);
  webSession.attach(window.webContents.session, appContents);
  await policy.prepare(`${setupOrigin}/desktop`);

  if (quitting) return;

  policy.attach(window.webContents.session, () => [setupOrigin, status.webUrl]);
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 }));
  tray.on("click", showMain);
  app.setAsDefaultProtocolClient(identity.scheme);
  void updates.start();
  broadcast();
  await window.loadURL(`${setupOrigin}/desktop`);

  if (quitting) return;
  // The local startup screen stays visible while restoring services or downloading PostgreSQL.
  configurationLock.active = true;

  try {
    // Vault failures leave startup/settings available; configure can retry after keychain unlock.
    const client = await savedRemoteClient(app.getPath("userData")).catch(() => undefined);

    if (quitting) return;

    if (client) logs.protect(client.token);

    if (client) remoteUpdate.selectDevice(client.deviceId);
    await remoteUpdate.publish();

    if (quitting) return;
    await rpc("restore", { remoteClient: client });

    if (status.phase === "running") await openApplication();
  } finally {
    configurationLock.active = false;
  }

  const link = pendingLink ?? process.argv.find((arg) => arg.startsWith(`${identity.scheme}://`));

  if (link) {
    pendingLink = undefined;
    enrollment(link);
  }
}

if (ownsInstance) void app.whenReady().then(start).catch(startupFailed);
