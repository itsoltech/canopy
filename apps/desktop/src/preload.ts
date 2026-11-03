import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopStatus, DesktopUpdateStatus, DesktopWindowState, QuitGuardState, QuitShortcut } from "@canopy/ui/desktop";

function subscribe<T>(channel: string, listener: (data: T) => void) {
  const receive = (_event: Electron.IpcRendererEvent, data: T) => listener(data);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}
const bridge: DesktopBridge = {
  platform: process.platform,
  windowState: () => ipcRenderer.invoke("canopy:window-state"),
  onWindowState: (listener) => subscribe<DesktopWindowState>("canopy:window-state", listener),
  status: () => ipcRenderer.invoke("canopy:status"),
  configure: (configuration) => ipcRenderer.invoke("canopy:configure", configuration),
  openSettings: () => ipcRenderer.invoke("canopy:settings"),
  quitShortcut: () => ipcRenderer.invoke("canopy:quit-shortcut"),
  setQuitShortcut: (shortcut) => ipcRenderer.invoke("canopy:set-quit-shortcut", shortcut),
  onQuitShortcut: (listener) => subscribe<QuitShortcut>("canopy:quit-shortcut", listener),
  onQuitGuard: (listener) => subscribe<QuitGuardState>("canopy:quit-guard", listener),
  updates: () => ipcRenderer.invoke("canopy:updates"),
  setUpdateChannel: (channel) => ipcRenderer.invoke("canopy:update-channel", channel),
  checkForUpdates: () => ipcRenderer.invoke("canopy:update-check"),
  restartToUpdate: () => ipcRenderer.invoke("canopy:update-install"),
  onUpdates: (listener) => subscribe<DesktopUpdateStatus>("canopy:updates", listener),
  onStatus: (listener) => subscribe<DesktopStatus>("canopy:status", listener),
  onEnrollment: (listener) => subscribe("canopy:enrollment", listener),
  readyForEnrollment: () => ipcRenderer.invoke("canopy:enrollment-ready"),
};
contextBridge.exposeInMainWorld("canopyDesktop", bridge);
