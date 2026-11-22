import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopBridge,
  DesktopHtmlEvent,
  DesktopStatus,
  DesktopUpdateStatus,
  DesktopWindowState,
  QuitGuardState,
  QuitShortcut,
} from "@canopy/ui/desktop";
import { QuitFeedback } from "./quit-feedback.ts";
import { quitFallback } from "./quit-fallback.ts";
import { isDesktopRoute } from "@canopy/ui/desktop";

const feedback = new QuitFeedback(
  quitFallback((phase) => ipcRenderer.send("canopy:quit-guard-delivered", phase, "shell")),
);

ipcRenderer.on("canopy:quit-guard", (_event, state: QuitGuardState) => feedback.receive(state));

window.addEventListener("online", (event) => {
  if (event.isTrusted) void ipcRenderer.invoke("canopy:usage-ping-online").catch(() => {});
});

function subscribe<T>(channel: string, listener: (data: T) => void) {
  const receive = (_event: Electron.IpcRendererEvent, data: T) => listener(data);
  ipcRenderer.on(channel, receive);

  return () => ipcRenderer.removeListener(channel, receive);
}

const bridge: DesktopBridge = {
  usagePing: {
    enabled: () => ipcRenderer.invoke("canopy:usage-ping"),
    setEnabled: (enabled) => ipcRenderer.invoke("canopy:set-usage-ping", enabled),
  },
  gatewayMigration: {
    status: () => ipcRenderer.invoke("canopy:migration-status"),
    prepare: (input) => ipcRenderer.invoke("canopy:migration-prepare", input),
    activate: (approval, selectedPeerIds) =>
      ipcRenderer.invoke("canopy:migration-activate", { approval, selectedPeerIds }),
    recover: () => ipcRenderer.invoke("canopy:migration-recover"),
    abort: () => ipcRenderer.invoke("canopy:migration-abort"),
  },
  openPreviewWindow: (path) => ipcRenderer.invoke("canopy:open-preview-window", path),
  openAgentHtml: (specJson, title) => ipcRenderer.invoke("canopy:agent-html-open", specJson, title),
  startAgentHtml: (input) => ipcRenderer.invoke("canopy:agent-html-start", input),
  commandAgentHtml: (id, command) => ipcRenderer.invoke("canopy:agent-html-command", id, command),
  stopAgentHtml: (id) => ipcRenderer.invoke("canopy:agent-html-stop", id),
  onAgentHtml: (listener) => subscribe<DesktopHtmlEvent>("canopy:agent-html-event", listener),
  listFonts: () => ipcRenderer.invoke("canopy:fonts"),
  history: {
    read: (key) => ipcRenderer.invoke("canopy:history-read", key),
    write: (generation, key, bytes) => ipcRenderer.invoke("canopy:history-write", generation, key, bytes),
    remove: (key) => ipcRenderer.invoke("canopy:history-remove", key),
    reconcileBots: (generation, ids) => ipcRenderer.invoke("canopy:history-reconcile-bots", generation, ids),
    clear: () => ipcRenderer.invoke("canopy:history-clear"),
  },
  platform: process.platform,
  showNotification: (notice) => ipcRenderer.invoke("canopy:notification", notice),
  onNotificationClick: (listener) => subscribe<string>("canopy:notification-click", listener),
  onOpenRoute: (listener) =>
    subscribe<string>("canopy:open-route", (path) => {
      if (isDesktopRoute(path)) listener(path);
    }),
  readyForRoutes: () => ipcRenderer.invoke("canopy:routes-ready"),
  startupAppearance: ipcRenderer.sendSync("canopy:appearance-startup"),
  setAppearance: (appearance) => ipcRenderer.invoke("canopy:appearance", appearance),
  windowState: () => ipcRenderer.invoke("canopy:window-state"),
  onWindowState: (listener) => subscribe<DesktopWindowState>("canopy:window-state", listener),
  windowControl: (control) => ipcRenderer.invoke("canopy:window-control", control),
  setWorkspaceBlocked: (blocked) => ipcRenderer.invoke("canopy:workspace-blocked", blocked),
  onWorkspaceClose: (listener) => subscribe<"close" | "quit">("canopy:workspace-close", listener),
  finishWorkspaceClose: (action) => ipcRenderer.invoke("canopy:workspace-finish-close", action),
  status: () => ipcRenderer.invoke("canopy:status"),
  configure: (configuration) => ipcRenderer.invoke("canopy:configure", configuration),
  openSettings: () => ipcRenderer.invoke("canopy:settings"),
  closeSettings: () => ipcRenderer.invoke("canopy:close-settings"),
  quitShortcut: () => ipcRenderer.invoke("canopy:quit-shortcut"),
  setQuitShortcut: (shortcut) => ipcRenderer.invoke("canopy:set-quit-shortcut", shortcut),
  onQuitShortcut: (listener) => subscribe<QuitShortcut>("canopy:quit-shortcut", listener),
  onQuitGuard: (listener, overlayVersion) =>
    feedback.subscribe((state) => {
      // Old overlays instruct "press again" after the 500 ms window has expired.
      // Hide those and keep the bundled feedback visible instead.
      const delivered = overlayVersion === 1 ? state : { ...state, phase: "cancel" as const, durationMs: 0 };
      listener(delivered);
      ipcRenderer.send("canopy:quit-guard-delivered", delivered.phase, "web");
    }, overlayVersion === 1),
  updates: () => ipcRenderer.invoke("canopy:updates"),
  appUpdateHistory: () => ipcRenderer.invoke("canopy:app-update-history"),
  releaseNotes: () => ipcRenderer.invoke("canopy:release-notes"),
  setUpdateChannel: (channel) => ipcRenderer.invoke("canopy:update-channel", channel),
  setUpdateCheckInterval: (minutes) => ipcRenderer.invoke("canopy:update-check-interval", minutes),
  checkForUpdates: () => ipcRenderer.invoke("canopy:update-check"),
  restartToUpdate: () => ipcRenderer.invoke("canopy:update-install"),
  onUpdates: (listener) => subscribe<DesktopUpdateStatus>("canopy:updates", listener),
  onStatus: (listener) => subscribe<DesktopStatus>("canopy:status", listener),
  onEnrollment: (listener) => subscribe("canopy:enrollment", listener),
  readyForEnrollment: () => ipcRenderer.invoke("canopy:enrollment-ready"),
  takeConnectorOAuth: () => ipcRenderer.invoke("canopy:connector-oauth"),
};

contextBridge.exposeInMainWorld("canopyDesktop", bridge);
