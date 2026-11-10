import { app, BrowserWindow, ipcMain, nativeImage, powerMonitor, Tray } from "electron";
import { monitorPower } from "./power-events.ts";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stopController } from "./runtime/process.ts";
import { join, resolve } from "node:path";
import type { QuitGuardState, QuitShortcut } from "@canopy/ui/desktop";
import { initialStatus, serviceEnvironment, type ConfigurationInput } from "./runtime/config.ts";
import { desktopLink } from "./desktop-link.ts";
import { holdConnectorOAuth, registerConnectorOAuthIpc } from "./connector-oauth-ipc.ts";
import type { ControllerArguments, ControllerResult } from "./controller.ts";
import { ControllerConnection } from "./controller-connection.ts";
import { loadSecrets } from "./vault.ts";
import { savedRemoteClient } from "./client-vault.ts";
import { closeModeChooser, configureDesktopMode, openModeChooser } from "./mode-configuration.ts";
import { Logs } from "./runtime/log.ts";
import { controllerEntry, runtimePaths } from "./runtime/launch.ts";
import { desktopIdentity, desktopUserData } from "./identity.ts";
import { DesktopUpdates } from "./updates.ts";
import { QuitGuard } from "./quit-guard.ts";
import { systemQuitClock } from "./quit-machine.ts";
import { quitKeyEvent } from "./quit-key-event.ts";
import { isQuitShortcut, QuitSettings } from "./quit-settings.ts";
import { windowState, registerWindowPreferencesIpc } from "./window-chrome.ts";
import { updateDesktopMenus } from "./desktop-menu.ts";
import { AppRoutes } from "./app-routes.ts";
import { registerAppRouteIpc, showAppRoute } from "./app-route-ipc.ts";
import { createDesktopWindow, isTrustedDesktopEvent, windowSizeLimits } from "./desktop-window.ts";
import { windowPlacement } from "./window-state.ts";
import { DocumentPolicy } from "./document-policy.ts";
import type { RemoteAppUpdate } from "./remote-app-update.ts";
import { acceptRemoteUpdate, remoteAppUpdate, registerUpdateIpc } from "./update-ipc.ts";
import { desktopHistory, registerHistoryIpc } from "./history-ipc.ts";
import { startupFailure } from "./startup-error.ts";

const identity = desktopIdentity();

// Electron also uses this name for Keychain / Secret Service encryption keys.
app.setName(identity.productName);

app.setPath("userData", desktopUserData(app.getPath("appData")));

app.setAboutPanelOptions({ applicationName: identity.displayName });

if (process.platform === "win32") app.setAppUserModelId(identity.appId);

// Chromium does not recognize every Linux desktop (e.g. Hyprland). Select a real
// keychain backend explicitly instead of silently falling back to basic_text.
if (process.platform === "linux" && !app.commandLine.hasSwitch("password-store")) {
  app.commandLine.appendSwitch(
    "password-store",
    /kde/i.test(process.env["XDG_CURRENT_DESKTOP"] ?? "") ? "kwallet6" : "gnome-libsecret",
  );
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
let stopPower = () => {};
let startupError = "";

const updates = new DesktopUpdates(broadcast, () => {
  installingUpdate = true;
  app.quit();
});

let remoteUpdate: RemoteAppUpdate | undefined;

let connection: ControllerConnection | undefined;
let pendingLink: string | undefined;
const enrollmentReady = new Set<number>();

const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build");

const iconPath = app.isPackaged
  ? join(resources, "icon.png")
  : resolve(app.getAppPath(), `build/${identity.channel}/icon.png`);

const logs = new Logs(join(app.getPath("userData"), "logs"));
const history = desktopHistory();
const quitSettings = new QuitSettings(app.getPath("userData"));
const quitLog = (decision: string) => logs.write("desktop", `quit-guard ${decision}`);
const quitKey = quitKeyEvent(quitLog);

const quitGuard = new QuitGuard(
  quitSettings.read(),
  {
    clock: systemQuitClock,
    shortcut: process.platform === "darwin" ? "⌘Q" : "Ctrl+Q",
    repeatTiming: quitKey.timing,
    quit: () => app.quit(),
    log: quitLog,
    emit: (state) => {
      for (const target of [window, settingsWindow])
        if (target && !target.isDestroyed()) target.webContents.send("canopy:quit-guard", state);
    },
  },
  process.platform,
);

const policy = new DocumentPolicy();
const appRoutes = new AppRoutes();

function rpc(action: string, args: ControllerArguments = {}) {
  return connection
    ? connection.request(action, args)
    : Promise.reject<ControllerResult>(new Error("Desktop services are unavailable; restart Canopy"));
}

function isTrusted(event: IpcMainInvokeEvent | IpcMainEvent, setupOnly = false) {
  return isTrustedDesktopEvent(event, [window, settingsWindow], setupOrigin, status.webUrl, setupOnly);
}

function authorize(event: IpcMainInvokeEvent | IpcMainEvent, setupOnly = false) {
  if (!isTrusted(event, setupOnly)) throw new Error("Untrusted desktop request");
}

function broadcast() {
  remoteUpdate?.changed();

  if (remoteUpdate && !remoteUpdate.active) void remoteUpdate.publish().catch(() => {});

  for (const target of [window, settingsWindow])
    if (target && !target.isDestroyed()) target.webContents.send("canopy:status", status);

  for (const target of [window, settingsWindow])
    if (target && !target.isDestroyed()) target.webContents.send("canopy:updates", updates.status());

  updateDesktopMenus({
    status,
    tray,
    productName: identity.displayName,
    showMain,
    openSettings,
    openAppSettings: () => openRoute("/settings"),
    updates,
    quitGuard,
    quitKey,
    logsDirectory: logs.directory,
  });
}

function showMain() {
  if (!setupOrigin || quitting) return;

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
  return createDesktopWindow({
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
}

function openRoute(path: string) {
  if (status.phase === "running" && !quitting) showAppRoute(appRoutes, path, showMain, () => window);
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

    if (!window || window.isDestroyed()) window = createWindow(true);
    await window.loadURL(status.webUrl);
    settingsWindow?.close();
  } catch {
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

  if (target && enrollmentReady.has(target.webContents.id)) {
    pendingLink = undefined;
    target.webContents.send("canopy:enrollment", parsed.enrollment);
  }
}

app.on("second-instance", (_event, argv) => {
  const link = argv.find((arg) => arg.startsWith(`${identity.scheme}://`));

  if (link) enrollment(link);
  else showMain();
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  enrollment(url);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", showMain);

process.on("SIGTERM", () => app.quit());

process.on("SIGINT", () => app.quit());

app.on("before-quit", (event) => {
  if (stopped) return;
  event.preventDefault();

  if (quitting) return;
  quitting = true;
  stopPower();
  quitGuard.cancel();

  for (const target of BrowserWindow.getAllWindows()) target.hide();
  updates.stop();
  remoteUpdate?.stop();

  const finish = () => {
    stopped = true;

    if (installingUpdate) updates.install();
    else app.quit();
  };

  // EOF makes the guardian stop owned process groups even if Electron subsequently crashes.
  void rpc("presence", {
    state: installingUpdate ? "updating" : "shutting_down",
    targetVersion: installingUpdate ? updates.status().updateVersion : undefined,
  })
    .catch(() => {})
    .finally(() => controller?.stdin.end());

  const timeout = setTimeout(() => stopController(controller), 35_000);

  if (
    !controller ||
    controllerExited ||
    !controller.pid ||
    controller.exitCode !== null ||
    controller.signalCode !== null
  ) {
    clearTimeout(timeout);
    finish();
  } else
    controller.once("exit", () => {
      clearTimeout(timeout);
      finish();
    });
});

function startController() {
  const runtime = join(resources, "runtime");
  const paths = runtimePaths(runtime);
  controller = spawn(paths.bun, [controllerEntry(runtime)], {
    stdio: "pipe",
    env: serviceEnvironment(),
    cwd: runtime,
    windowsHide: true,
  });
  connection = new ControllerConnection(
    controller,
    logs,
    (next) => {
      if (next.needsPairing && !status.needsPairing) void history.clear();
      status = startupError ? { ...next, phase: "error", error: startupError } : next;
      broadcast();
    },
    () => {
      controllerExited = true;

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
  registerHistoryIpc(history, authorize, () => status.phase === "running" && !status.needsPairing);
  registerWindowPreferencesIpc(authorize, iconPath);
  registerAppRouteIpc(appRoutes, authorize, () => window);
  ipcMain.handle("canopy:status", (event) => {
    authorize(event);

    return status;
  });
  ipcMain.handle("canopy:window-state", (event) => {
    authorize(event);

    return windowState(BrowserWindow.fromWebContents(event.sender)!);
  });
  ipcMain.handle("canopy:settings", (event) => {
    authorize(event);
    openSettings();
  });
  ipcMain.handle("canopy:quit-shortcut", (event) => {
    authorize(event);

    return quitGuard.mode;
  });
  ipcMain.on("canopy:quit-guard-delivered", (event, phase: QuitGuardState["phase"], surface: "web" | "shell") => {
    if (
      !isTrusted(event) ||
      !["hint", "holding", "cancel"].includes(phase) ||
      (surface !== "web" && surface !== "shell")
    )
      return;
    quitLog(
      `feedback phase=${phase} surface=${surface} window=${event.sender === settingsWindow?.webContents ? "settings" : "main"}`,
    );
  });
  ipcMain.handle("canopy:set-quit-shortcut", (event, value: QuitShortcut) => {
    authorize(event);

    if (!isQuitShortcut(value)) throw new Error("Invalid quit shortcut");
    quitSettings.write(value);
    quitGuard.cancel();
    quitGuard.mode = value;

    for (const target of [window, settingsWindow])
      if (target && !target.isDestroyed()) target.webContents.send("canopy:quit-shortcut", value);

    return value;
  });
  registerUpdateIpc(updates, () => remoteUpdate, authorize);
  registerConnectorOAuthIpc(authorize);
  ipcMain.handle("canopy:enrollment-ready", (event) => {
    authorize(event, true);
    enrollmentReady.add(event.sender.id);

    if (pendingLink) enrollment(pendingLink);
  });
  ipcMain.handle("canopy:configure", async (event, raw: ConfigurationInput) => {
    authorize(event, true);

    if (busy) throw new Error("Desktop configuration is already in progress");

    busy = true;

    try {
      return await configureDesktopMode(event, raw, {
        status,
        directory: app.getPath("userData"),
        remoteUpdate,
        logs,
        closeSettings: () => closeModeChooser(settingsWindow, window),
        apply: async (config, client) => {
          await history.clear();
          startupError = "";
          await rpc("configure", { configuration: config, remoteClient: client });

          if (status.phase === "running") await openApplication();

          if (status.phase === "error") throw new Error(status.error ?? "Could not save desktop mode");
        },
      });
    } finally {
      busy = false;
    }
  });
  ipcMain.handle("canopy:close-settings", (event) => {
    authorize(event, true);
    closeModeChooser(settingsWindow, window);
  });
}

async function start() {
  stopPower = monitorPower(powerMonitor, async (state) => {
    await rpc("presence", { state });
  });
  const secrets = await loadSecrets(app.getPath("userData"));
  logs.protect(...Object.values(secrets));
  const paths = startController();
  remoteUpdate = remoteAppUpdate(updates, rpc);
  await remoteUpdate.publish();
  const initialized = await rpc("initialize", { directory: app.getPath("userData"), secrets, paths });

  if (!initialized.origin || !initialized.status) throw new Error("Invalid desktop initialization response");

  setupOrigin = initialized.origin;
  status = initialized.status;
  registerIpc();
  window = createWindow(true);
  await policy.prepare(`${setupOrigin}/desktop`);

  policy.attach(window.webContents.session, () => [setupOrigin, status.webUrl]);
  const image = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(image);
  tray.on("click", showMain);
  app.setAsDefaultProtocolClient(identity.scheme);
  void updates.start();
  broadcast();
  await window.loadURL(`${setupOrigin}/desktop`);
  // The local startup screen stays visible while restoring services or downloading PostgreSQL.
  busy = true;

  try {
    // Vault failures leave startup/settings available; configure can retry after keychain unlock.
    const client = await savedRemoteClient(app.getPath("userData")).catch(() => undefined);

    if (client) logs.protect(client.token);

    if (client) remoteUpdate.selectDevice(client.deviceId);
    await remoteUpdate.publish();
    await rpc("restore", { remoteClient: client });

    if (status.phase === "running") await openApplication();
  } finally {
    busy = false;
  }

  const link = pendingLink ?? process.argv.find((arg) => arg.startsWith(`${identity.scheme}://`));

  if (link) {
    pendingLink = undefined;
    enrollment(link);
  }
}

if (ownsInstance) void app.whenReady().then(start).catch(startupFailure(logs));
