"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("brainPet", Object.freeze({
  getBootstrap: () => ipcRenderer.invoke("brainpet:stage-bootstrap"),
  ready: () => ipcRenderer.send("brainpet:stage-ready"),
  report: (event) => ipcRenderer.send("brainpet:stage-event", event),
  close: () => ipcRenderer.send("brainpet:stage-close"),
  onHostEvent: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, value) => {
      if (!value) return;
      if (value.type === "agent-completed" && (value.surface === "default" || value.surface === "agent")) {
        listener(Object.freeze({ type: value.type, surface: value.surface }));
        return;
      }
      if (value.type === "session-outcome"
        && typeof value.passed === "boolean"
        && Number.isInteger(value.previousLevel)
        && Number.isInteger(value.nextLevel)
        && typeof value.accuracy === "number"
        && typeof value.isNewLevelBest === "boolean"
        && Number.isInteger(value.todayCompleted)) {
        listener(Object.freeze({ type: value.type, passed: value.passed, previousLevel: value.previousLevel, nextLevel: value.nextLevel, accuracy: value.accuracy, isNewLevelBest: value.isNewLevelBest, todayCompleted: value.todayCompleted }));
        return;
      }
      if (value.type !== "pause" && value.type !== "resume") return;
      if (value.reason !== "lock-screen" && value.reason !== "suspend") return;
      listener(Object.freeze({ type: value.type, reason: value.reason }));
    };
    ipcRenderer.on("brainpet:host-event", handler);
    return () => ipcRenderer.off("brainpet:host-event", handler);
  },
}));
