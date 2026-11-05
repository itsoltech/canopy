import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopBridge,
  DesktopStatus,
  DesktopUpdateStatus,
  DesktopWindowState,
  QuitGuardState,
  QuitShortcut,
} from "@canopy/ui/desktop";
import { QuitFeedback } from "./quit-feedback.ts";
import { quitFallback } from "./quit-fallback.ts";

const feedback = new QuitFeedback(
  quitFallback((phase) => ipcRenderer.send("canopy:quit-guard-delivered", phase, "shell")),
);

ipcRenderer.on("canopy:quit-guard", (_event, state: QuitGuardState) => feedback.receive(state));

function subscribe<T>(channel: string, listener: (data: T) => void) {
  const receive = (_event: Electron.IpcRendererEvent, data: T) => listener(data);
  ipcRenderer.on(channel, receive);

  return () => ipcRenderer.removeListener(channel, receive);
}

const bridge: DesktopBridge = {
  platform: process.platform,
  showThreadNotification: (notice) => ipcRenderer.invoke("canopy:thread-notification", notice),
  onThreadNotificationClick: (listener) => subscribe<string>("canopy:thread-notification-click", listener),
  startupAppearance: ipcRenderer.sendSync("canopy:appearance-startup"),
  setAppearance: (appearance) => ipcRenderer.invoke("canopy:appearance", appearance),
  windowState: () => ipcRenderer.invoke("canopy:window-state"),
  onWindowState: (listener) => subscribe<DesktopWindowState>("canopy:window-state", listener),
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
