import { contextBridge, ipcRenderer } from "electron";

// Dedicated viewer only. No application bridge, credentials or generic IPC.
contextBridge.exposeInMainWorld("ReactNativeWebView", {
  postMessage: (message: string) => ipcRenderer.send("canopy:agent-html-message", message),
});

// The shell accepts only token envelopes with no source. No agent code or generic IPC is exposed.
ipcRenderer.on("canopy:agent-html-host", (_event, envelope: string) => {
  window.dispatchEvent(new MessageEvent("message", { data: envelope }));
});
