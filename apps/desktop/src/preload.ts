import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopStatus } from "@open-agents/ui/desktop";

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
  onStatus: (listener) => subscribe<DesktopStatus>("canopy:status", listener),
  onEnrollment: (listener) => subscribe("canopy:enrollment", listener),
  readyForEnrollment: () => ipcRenderer.invoke("canopy:enrollment-ready"),
};
contextBridge.exposeInMainWorld("canopyDesktop", bridge);
