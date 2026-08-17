import { app, BrowserWindow, ipcMain, powerMonitor, screen } from "electron";
import { join } from "node:path";

import { applyExternalPetReaction, getDefaultPetWindowForPlugins, prepareDefaultPetWindowForTraining, recycleDefaultPetWindowAfterTraining } from "../default-pet-controller.js";
import { getAppStateSnapshot } from "../app-state.js";
import { debug, info } from "../logger.js";
import { setBrainPetDragLifecycleHandler, setBrainPetTrainingRequestHandler, setPetWindowPositionLocked } from "../pet-window.js";
import { subscribeHostAgentActivity } from "../host-agent-activity.js";
import { isBrainPetAgentCompletion, parseBrainPetAgentActivity } from "./agent-activity-policy.js";
import { BrainPetInteractionRigController } from "./interaction-rig-controller.js";
import { isBrainPetRigPointer } from "./rig-drag-gesture.js";
import { createBrainPetRuntimeSnapshot, type BrainPetRuntimeSnapshot } from "./runtime-core.js";
import { BrainPetSessionAuthority, type BrainPetStageBootstrap } from "./session-authority.js";
import { BrainPetStageWindowController } from "./stage-window-controller.js";
import { BrainPetTrainingEntry } from "./training-entry.js";

export type { BrainPetStageBootstrap } from "./session-authority.js";

const STAGE_READY_CHANNEL = "brainpet:stage-ready";
const STAGE_EVENT_CHANNEL = "brainpet:stage-event";
const STAGE_CLOSE_CHANNEL = "brainpet:stage-close";
const STAGE_BOOTSTRAP_CHANNEL = "brainpet:stage-bootstrap";
const STAGE_NEXT_SESSION_CHANNEL = "brainpet:stage-next-session";
const STAGE_INTERACTIVE_CHANNEL = "brainpet:stage-interactive";
const PET_THROW_CHANNEL = "brainpet:pet-throw";
const RIG_DRAG_START_CHANNEL = "brainpet:rig-drag-start";
const RIG_DRAG_MOVE_CHANNEL = "brainpet:rig-drag-move";
const RIG_DRAG_END_CHANNEL = "brainpet:rig-drag-end";

let ipcInstalled = false;
let hostEventsInstalled = false;
let unsubscribeAgentActivity: (() => void) | null = null;
let sessionAuthority: BrainPetSessionAuthority | null = null;
let trainingEntry: BrainPetTrainingEntry | null = null;
let interactionRigController: BrainPetInteractionRigController | null = null;
let stageWindowController: BrainPetStageWindowController | null = null;
let trainingPreparationTimer: NodeJS.Timeout | null = null;
let brainPetHostEnabled = false;

export function initializeBrainPetHost(): void {
  brainPetHostEnabled = true;
  interactionRigController = new BrainPetInteractionRigController({
    getStageWindow: () => stageWindowController?.window ?? null,
    closeStage: (reason) => closeBrainPetStage(reason),
    emitStageEvent: (event) => stageWindowController?.sendHostEvent(event),
    displayForBounds: (bounds) => {
      const display = screen.getDisplayMatching(bounds);
      return { displayId: String(display.id), scaleFactor: display.scaleFactor, workArea: display.workArea };
    },
    displayForPoint: (point) => {
      const display = screen.getDisplayNearestPoint({ x: Math.round(point.screenX), y: Math.round(point.screenY) });
      return { displayId: String(display.id), scaleFactor: display.scaleFactor, workArea: display.workArea };
    },
    setPositionLocked: setPetWindowPositionLocked,
  });
  sessionAuthority = new BrainPetSessionAuthority({
    statePath: join(app.getPath("userData"), "brainpet-state.json"),
    emitStageEvent: (event) => stageWindowController?.sendHostEvent(event),
    emitAccessoryFeedback: (tone) => {
      const anchor = interactionRigController?.anchorWindow;
      if (anchor && !anchor.isDestroyed()) anchor.webContents.send("openpets:brainpet-accessory-feedback", { tone });
    },
    applyPetReaction: (reaction) => applyExternalPetReaction(reaction, { showMessage: false }),
  });
  stageWindowController = new BrainPetStageWindowController({
    authority: sessionAuthority,
    rigController: interactionRigController,
    resolveDefaultAnchor: getDefaultPetWindowForPlugins,
    createWindow: (options) => new BrowserWindow(options),
    getAppPath: () => app.getAppPath(),
    getCursorScreenPoint: () => screen.getCursorScreenPoint(),
    onClosed: recycleDefaultPetWindowAfterTraining,
  });
  trainingEntry = new BrainPetTrainingEntry({
    register: (handler) => setBrainPetTrainingRequestHandler(handler),
    // The stage is the user-visible critical path. The post-training pet
    // thumbnail is restored only after this stage renderer reports ready so two
    // renderer loads cannot contend during the opening budget.
    open: (sourceWindow) => openBrainPetStage(sourceWindow),
    close: (reason) => closeBrainPetStage(reason),
    isOpen: () => stageWindowController?.isOpen ?? false,
  });
  installBrainPetIpc();
  installBrainPetHostEvents();
  trainingEntry.start();
  setBrainPetDragLifecycleHandler(handlePetDragLifecycle);
  info("brainpet.host", "initialized");
}

export function openBrainPetStage(anchorWindow?: BrowserWindow): void {
  if (!brainPetHostEnabled) return;
  stageWindowController?.open(anchorWindow);
}

export function closeBrainPetStage(reason = "requested"): void {
  stageWindowController?.close(reason);
}

export async function shutdownBrainPetHost(): Promise<void> {
  brainPetHostEnabled = false;
  if (trainingPreparationTimer) clearTimeout(trainingPreparationTimer);
  trainingPreparationTimer = null;
  trainingEntry?.dispose();
  trainingEntry = null;
  setBrainPetDragLifecycleHandler(null);
  stageWindowController?.dispose();
  stageWindowController = null;
  interactionRigController?.dispose();
  interactionRigController = null;
  removeBrainPetHostEvents();
  const authority = sessionAuthority;
  sessionAuthority = null;
  await authority?.dispose();
}

function installBrainPetHostEvents(): void {
  if (hostEventsInstalled) return;
  hostEventsInstalled = true;
  powerMonitor.on("lock-screen", handleLockScreen);
  powerMonitor.on("unlock-screen", handleUnlockScreen);
  powerMonitor.on("suspend", handleSuspend);
  powerMonitor.on("resume", handleResume);
  screen.on("display-added", handleDisplayChange);
  screen.on("display-removed", handleDisplayChange);
  screen.on("display-metrics-changed", handleDisplayChange);
  unsubscribeAgentActivity = subscribeHostAgentActivity((payload) => handleAgentActivity(payload as unknown as Record<string, unknown>));
}

function removeBrainPetHostEvents(): void {
  if (!hostEventsInstalled) return;
  hostEventsInstalled = false;
  powerMonitor.off("lock-screen", handleLockScreen);
  powerMonitor.off("unlock-screen", handleUnlockScreen);
  powerMonitor.off("suspend", handleSuspend);
  powerMonitor.off("resume", handleResume);
  screen.off("display-added", handleDisplayChange);
  screen.off("display-removed", handleDisplayChange);
  screen.off("display-metrics-changed", handleDisplayChange);
  unsubscribeAgentActivity?.();
  unsubscribeAgentActivity = null;
}

function handleLockScreen(): void { sendPauseEvent("pause", "lock-screen"); }
function handleUnlockScreen(): void { sendPauseEvent("resume", "lock-screen"); }
function handleSuspend(): void { sendPauseEvent("pause", "suspend"); }
function handleResume(): void { sendPauseEvent("resume", "suspend"); interactionRigController?.reflow("resume"); }
function handleDisplayChange(): void { interactionRigController?.reflow("display-change"); }

function sendPauseEvent(type: "pause" | "resume", reason: "lock-screen" | "suspend"): void {
  if (!stageWindowController?.isOpen) return;
  info("brainpet.host", "host lifecycle event", { type, reason, runtimePhase: sessionAuthority?.phase ?? "idle" });
  stageWindowController.sendHostEvent({ type, reason });
}

function handleAgentActivity(payload: Record<string, unknown>): void {
  const activity = parseBrainPetAgentActivity(payload);
  if (!activity || !isBrainPetAgentCompletion(activity)) return;
  if (!stageWindowController?.isOpen) return;
  debug("brainpet.host", "agent completion observed without interrupting stage", { surface: activity.surface, runtimePhase: sessionAuthority?.phase ?? "idle" });
  stageWindowController.sendHostEvent({ type: "agent-completed", surface: activity.surface });
}

export function getBrainPetRuntimeSnapshot(): BrainPetRuntimeSnapshot {
  return sessionAuthority?.snapshot ?? createBrainPetRuntimeSnapshot();
}

function installBrainPetIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;

  ipcMain.handle(STAGE_BOOTSTRAP_CHANNEL, (event): BrainPetStageBootstrap => {
    requireStageWindowController().assertSender(event);
    const rig = interactionRigController?.snapshot;
    if (!rig) throw new Error("BrainPet interaction rig is unavailable.");
    return requireSessionAuthority().createBootstrap(rig, getCurrentPetSpriteUrl());
  });
  ipcMain.handle(STAGE_NEXT_SESSION_CHANNEL, (event, value: unknown) => {
    requireStageWindowController().assertSender(event);
    return requireSessionAuthority().issueRetry(value);
  });
  ipcMain.on(STAGE_READY_CHANNEL, (event) => {
    if (!stageWindowController?.isSender(event)) return;
    sessionAuthority?.stageReady();
    scheduleDefaultPetTrainingPreparation(stageWindowController.window);
  });
  ipcMain.on(STAGE_CLOSE_CHANNEL, (event) => {
    if (!stageWindowController?.isSender(event)) return;
    closeBrainPetStage("renderer-requested");
  });
  ipcMain.on(STAGE_INTERACTIVE_CHANNEL, (event, interactive: unknown) => {
    if (!stageWindowController?.isSender(event) || typeof interactive !== "boolean") return;
    stageWindowController.setRendererInteractive(interactive);
  });
  ipcMain.on(PET_THROW_CHANNEL, (event, stimulusId: unknown) => {
    if (!stageWindowController?.isSender(event) || typeof stimulusId !== "string" || stimulusId.length === 0 || stimulusId.length > 128 || sessionAuthority?.phase !== "running") return;
    interactionRigController?.animatePetThrow(stimulusId);
  });
  ipcMain.on(RIG_DRAG_START_CHANNEL, (event, point: unknown) => {
    if (!stageWindowController?.isSender(event) || !isBrainPetRigPointer(point)) return;
    interactionRigController?.beginStageDrag(point);
  });
  ipcMain.on(RIG_DRAG_MOVE_CHANNEL, (event, point: unknown) => {
    if (!stageWindowController?.isSender(event) || !isBrainPetRigPointer(point)) return;
    interactionRigController?.moveStageDrag(point);
  });
  ipcMain.on(RIG_DRAG_END_CHANNEL, (event) => {
    if (!stageWindowController?.isSender(event)) return;
    interactionRigController?.endStageDrag();
  });
  ipcMain.on(STAGE_EVENT_CHANNEL, (event, value: unknown) => {
    if (!stageWindowController?.isSender(event)) return;
    sessionAuthority?.handleStageEvent(value);
  });
}

function scheduleDefaultPetTrainingPreparation(stageWindow: BrowserWindow | null): void {
  if (!stageWindow) return;
  if (trainingPreparationTimer) clearTimeout(trainingPreparationTimer);
  trainingPreparationTimer = setTimeout(() => {
    trainingPreparationTimer = null;
    if (stageWindowController?.window !== stageWindow || !stageWindowController.isOpen) return;
    prepareDefaultPetWindowForTraining();
  }, 500);
  trainingPreparationTimer.unref?.();
}

function handlePetDragLifecycle(sourceWindow: BrowserWindow, phase: "start" | "end"): void {
  interactionRigController?.handlePetDragLifecycle(sourceWindow, phase);
}

function getCurrentPetSpriteUrl(): string | null {
  const state = getAppStateSnapshot();
  const pet = state.pets.installed.find((candidate) => candidate.id === state.preferences.defaultPetId);
  if (!pet || pet.builtIn) return null;
  const scheme = pet.source?.kind === "codex" ? "openpets-codex" : "openpets-installed";
  return `${scheme}://spritesheet/${encodeURIComponent(pet.id)}`;
}

function requireSessionAuthority(): BrainPetSessionAuthority {
  if (!sessionAuthority) throw new Error("BrainPet SessionAuthority is not initialized.");
  return sessionAuthority;
}

function requireInteractionRigController(): BrainPetInteractionRigController {
  if (!interactionRigController) throw new Error("BrainPet InteractionRigController is not initialized.");
  return interactionRigController;
}

function requireStageWindowController(): BrainPetStageWindowController {
  if (!stageWindowController) throw new Error("BrainPet StageWindowController is not initialized.");
  return stageWindowController;
}
