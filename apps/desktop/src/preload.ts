import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopStatus, DesktopUpdateStatus } from "@canopy/ui/desktop";

function subscribe<T>(channel: string, listener: (data: T) => void) {
  const receive = (_event: Electron.IpcRendererEvent, data: T) => listener(data);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}
const bridge: DesktopBridge = {
  platform: process.platform,
  status: () => ipcRenderer.invoke("canopy:status"),
  configure: (configuration) => ipcRenderer.invoke("canopy:configure", configuration),
  openSettings: () => ipcRenderer.invoke("canopy:settings"),
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
