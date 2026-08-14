"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("brainPet", Object.freeze({
  getBootstrap: () => ipcRenderer.invoke("brainpet:stage-bootstrap"),
  nextSession: (taskId, level) => ipcRenderer.invoke("brainpet:stage-next-session", { taskId, level }),
  ready: () => ipcRenderer.send("brainpet:stage-ready"),
  report: (event) => ipcRenderer.send("brainpet:stage-event", event),
  setInteractive: (interactive) => ipcRenderer.send("brainpet:stage-interactive", interactive === true),
  animatePetThrow: (stimulusId) => {
    if (typeof stimulusId === "string" && stimulusId.length > 0 && stimulusId.length <= 128) ipcRenderer.send("brainpet:pet-throw", stimulusId);
  },
  beginRigDrag: (point) => sendRigPoint("brainpet:rig-drag-start", point),
  moveRigDrag: (point) => sendRigPoint("brainpet:rig-drag-move", point),
  endRigDrag: () => ipcRenderer.send("brainpet:rig-drag-end"),
  close: () => ipcRenderer.send("brainpet:stage-close"),
  onHostEvent: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, value) => {
      if (!value) return;
      if ((value.type === "rig-geometry-changed" || value.type === "rig-drag-start" || value.type === "rig-drag-end" || value.type === "rig-invalidated") && isRigSnapshot(value.rig)) {
        const event = { type: value.type, rig: freezeRigSnapshot(value.rig) };
        if (value.type === "rig-drag-start" || value.type === "rig-drag-end") event.source = value.source === "stage" ? "stage" : "pet";
        if (value.type === "rig-invalidated") event.reason = value.reason === "resume" ? "resume" : "display-change";
        listener(Object.freeze(event));
        return;
      }
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

function sendRigPoint(channel, point) {
  if (!point || !Number.isFinite(point.screenX) || !Number.isFinite(point.screenY)) return;
  ipcRenderer.send(channel, { screenX: point.screenX, screenY: point.screenY });
}

function isRectangle(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.width) && value.width > 0 && Number.isFinite(value.height) && value.height > 0;
}

function isPoint(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function isRigSnapshot(value) {
  return value && value.apiVersion === 1 && typeof value.rigId === "string" && value.rigId.length <= 128
    && Number.isInteger(value.petWindowId) && isRectangle(value.petBoundsScreen) && isRectangle(value.stageBoundsScreen)
    && isRectangle(value.overlayBoundsScreen) && isRectangle(value.reactionBoundsScreen) && isPoint(value.throwOriginScreen)
    && isPoint(value.throwOriginOverlay) && typeof value.displayId === "string" && Number.isFinite(value.scaleFactor)
    && typeof value.dragging === "boolean" && Number.isInteger(value.sequence) && Number.isFinite(value.atMs);
}

function freezeRigSnapshot(value) {
  return Object.freeze({
    ...value,
    petBoundsScreen: Object.freeze({ ...value.petBoundsScreen }),
    stageBoundsScreen: Object.freeze({ ...value.stageBoundsScreen }),
    overlayBoundsScreen: Object.freeze({ ...value.overlayBoundsScreen }),
    reactionBoundsScreen: Object.freeze({ ...value.reactionBoundsScreen }),
    throwOriginScreen: Object.freeze({ ...value.throwOriginScreen }),
    throwOriginOverlay: Object.freeze({ ...value.throwOriginOverlay }),
  });
}
