const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("brainpetSetup", Object.freeze({
  confirmBridge: () => ipcRenderer.invoke("brainpet:setup-confirm-bridge"),
}));
