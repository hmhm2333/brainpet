const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("brainpetSetup", Object.freeze({
  getAdapterStatus: () => ipcRenderer.invoke("brainpet:setup-adapter-status"),
  connectCodex: () => ipcRenderer.invoke("brainpet:setup-connect-codex"),
  disconnectCodex: () => ipcRenderer.invoke("brainpet:setup-disconnect-codex"),
}));
