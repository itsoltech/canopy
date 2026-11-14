import { contextBridge, ipcRenderer } from "electron";

// Dedicated viewer only. No application bridge, credentials or generic IPC.
contextBridge.exposeInMainWorld("ReactNativeWebView", {
  postMessage: (message: string) => ipcRenderer.send("canopy:agent-html-message", message),
});
