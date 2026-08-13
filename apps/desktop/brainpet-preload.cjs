"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("brainPet", Object.freeze({
  getBootstrap: () => ipcRenderer.invoke("brainpet:stage-bootstrap"),
  ready: () => ipcRenderer.send("brainpet:stage-ready"),
  report: (event) => ipcRenderer.send("brainpet:stage-event", event),
  close: () => ipcRenderer.send("brainpet:stage-close"),
}));
