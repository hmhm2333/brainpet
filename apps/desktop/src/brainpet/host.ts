import { app, BrowserWindow, ipcMain, powerMonitor, screen, type IpcMainEvent, type Session } from "electron";
import { join } from "node:path";

import { applyExternalPetReaction, getDefaultPetWindowForPlugins } from "../default-pet-controller.js";
import { getAppStateSnapshot } from "../app-state.js";
import { debug, error as logError, info, warn } from "../logger.js";
import { setBrainPetDragLifecycleHandler, setBrainPetTrainingRequestHandler, setPetWindowPositionLocked } from "../pet-window.js";
import { subscribeHostAgentActivity } from "../host-agent-activity.js";
import { isBrainPetAgentCompletion, parseBrainPetAgentActivity } from "./agent-activity-policy.js";
import { createBrainPetInteractionRig, isBrainPetPointInsideRectangle, reanchorBrainPetInteractionRig, reflowBrainPetInteractionRig, setBrainPetInteractionRigDragging, translateBrainPetStageInRig, type BrainPetInteractionRigSnapshot, type BrainPetRigEnvironment } from "./interaction-rig.js";
import { chooseBrainPetTask, localDateKey } from "./progression.js";
import { isBrainPetRigPointer, type BrainPetRigPointer } from "./rig-drag-gesture.js";
import { createBrainPetRuntimeSnapshot, createSeed, reduceBrainPetRuntime, type BrainPetRuntimeEvent, type BrainPetRuntimeSnapshot } from "./runtime-core.js";
import { canonicalizeBrainPetTaskResult, type BrainPetTaskResult, type BrainPetTaskSessionConfig } from "./task-contract.js";
import { getBrainPetDifficultyParameters, getBrainPetTaskDefinition, getBrainPetTaskManifest, isPlayableBrainPetTaskId, isRegisteredBrainPetTaskId, listPlayableBrainPetTaskIds } from "./task-registry.js";
import { appendBrainPetResult, createBrainPetPersistedState, loadBrainPetState, saveBrainPetState, type BrainPetPersistedState } from "./state.js";
import { matchesIssuedBrainPetSession } from "./session-ownership.js";

const STAGE_READY_CHANNEL = "brainpet:stage-ready";
const STAGE_EVENT_CHANNEL = "brainpet:stage-event";
const STAGE_CLOSE_CHANNEL = "brainpet:stage-close";
const STAGE_BOOTSTRAP_CHANNEL = "brainpet:stage-bootstrap";
const STAGE_HOST_EVENT_CHANNEL = "brainpet:host-event";
const STAGE_NEXT_SESSION_CHANNEL = "brainpet:stage-next-session";
const STAGE_INTERACTIVE_CHANNEL = "brainpet:stage-interactive";
const PET_THROW_CHANNEL = "brainpet:pet-throw";
const RIG_DRAG_START_CHANNEL = "brainpet:rig-drag-start";
const RIG_DRAG_MOVE_CHANNEL = "brainpet:rig-drag-move";
const RIG_DRAG_END_CHANNEL = "brainpet:rig-drag-end";

let stageWindow: BrowserWindow | null = null;
let runtime: BrainPetRuntimeSnapshot = createBrainPetRuntimeSnapshot();
let ipcInstalled = false;
let repositionTimer: NodeJS.Timeout | null = null;
let stageHitTestTimer: NodeJS.Timeout | null = null;
let rendererRequestedInteractive = false;
let stageMouseInteractive: boolean | null = null;
let stageAnchorWindow: BrowserWindow | null = null;
let statePath: string | null = null;
let persistedState: BrainPetPersistedState = createBrainPetPersistedState();
let stateSaveChain: Promise<void> = Promise.resolve();
let hostEventsInstalled = false;
let unsubscribeAgentActivity: (() => void) | null = null;
let issuedSession: BrainPetTaskSessionConfig | null = null;
const hardenedStageSessions = new WeakSet<Session>();
let interactionRig: BrainPetInteractionRigSnapshot | null = null;
let rigDragTransaction: { readonly source: "pet" | "stage"; readonly initial: BrainPetInteractionRigSnapshot; readonly startPointer?: BrainPetRigPointer; readonly settleOnMovement: boolean } | null = null;
let rigSettleTimer: NodeJS.Timeout | null = null;
let rigGeometryTimer: NodeJS.Timeout | null = null;
let applyingRigBounds = false;
let removeStageAnchorListeners: (() => void) | null = null;
let anchorSyncScheduled = false;
let lastPetThrowAt = 0;
let brainPetHostEnabled = false;

export interface BrainPetStageBootstrap {
  readonly apiVersion: 1;
  readonly mode: "stage-exerciser" | "training";
  readonly suggestedSeed: number;
  readonly session: BrainPetTaskSessionConfig;
  readonly availableTasks: readonly BrainPetTaskResult["taskId"][];
  readonly lastResult: BrainPetTaskResult | null;
  readonly highScores: BrainPetPersistedState["highScores"];
  readonly levelHighScore: number;
  readonly todayCompleted: number;
  readonly petSpriteUrl: string | null;
  readonly rig: BrainPetInteractionRigSnapshot;
}

export function initializeBrainPetHost(): void {
  brainPetHostEnabled = true;
  installBrainPetIpc();
  installBrainPetHostEvents();
  statePath = join(app.getPath("userData"), "brainpet-state.json");
  persistedState = loadBrainPetState(statePath, (message) => warn("brainpet.host", message));
  setBrainPetTrainingRequestHandler((sourceWindow) => requestBrainPetTraining(sourceWindow));
  setBrainPetDragLifecycleHandler(handlePetDragLifecycle);
  info("brainpet.host", "initialized");
}

function requestBrainPetTraining(sourceWindow: BrowserWindow): void {
  toggleBrainPetStage(sourceWindow, "built-in-training-entry");
}

function toggleBrainPetStage(anchorWindow: BrowserWindow | undefined, reason: string): void {
  if (stageWindow && !stageWindow.isDestroyed()) {
    closeBrainPetStage(reason);
    return;
  }
  openBrainPetStage(anchorWindow);
}

export function openBrainPetStage(anchorWindow?: BrowserWindow): void {
  if (!brainPetHostEnabled) return;
  const current = stageWindow;
  if (current && !current.isDestroyed()) {
    if (anchorWindow && !anchorWindow.isDestroyed() && anchorWindow !== stageAnchorWindow) {
      bindStageAnchor(anchorWindow);
      interactionRig = createInteractionRig(anchorWindow);
      applyInteractionRig(interactionRig, true);
    } else {
      synchronizeInteractionRigFromPet();
    }
    if (current.isMinimized()) current.restore();
    current.show();
    current.focus();
    return;
  }

  const resolvedAnchor = anchorWindow && !anchorWindow.isDestroyed() ? anchorWindow : getDefaultPetWindowForPlugins();
  if (!resolvedAnchor || resolvedAnchor.isDestroyed()) {
    warn("brainpet.host", "stage open skipped because no live pet anchor exists");
    return;
  }
  bindStageAnchor(resolvedAnchor);
  runtime = transition({ type: "open-requested", atMs: performance.now() });
  interactionRig = createInteractionRig(resolvedAnchor);
  const bounds = interactionRig.overlayBoundsScreen;
  const window = new BrowserWindow({
    title: "BrainPet Training Stage",
    ...bounds,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      webgl: false,
      partition: "persist:brainpet-stage",
      preload: join(app.getAppPath(), "brainpet-preload.cjs"),
    },
  });

  const stageSession = window.webContents.session;
  stageWindow = window;
  resolvedAnchor.webContents.send("openpets:brainpet-stage-state", { open: true });
  rendererRequestedInteractive = false;
  stageMouseInteractive = false;
  window.setIgnoreMouseEvents(true, { forward: true });
  hardenStageSession(stageSession);
  window.setMenu(null);
  window.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "normal");
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    logError("brainpet.host", "stage load failed", { errorCode, errorDescription });
    closeBrainPetStage("load-failed");
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    logError("brainpet.host", "stage renderer gone", { reason: details.reason, exitCode: details.exitCode });
    closeBrainPetStage("renderer-gone");
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const fields = { level, message, line, sourceId };
    if (level >= 3) logError("brainpet.stage", "renderer console", fields);
    else if (level === 2) warn("brainpet.stage", "renderer console", fields);
    else debug("brainpet.stage", "renderer console", fields);
  });
  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    synchronizeInteractionRigFromPet();
    window.show();
    window.focus();
  });
  window.on("closed", () => {
    if (stageWindow === window) stageWindow = null;
    clearRigSettleTimer();
    clearRigGeometryTimer();
    rigDragTransaction = null;
    interactionRig = null;
    unbindStageAnchor();
    stopRepositionTimer();
    stopStageHitTestTimer();
    if (runtime.phase !== "idle") {
      if (runtime.phase !== "closing") runtime = transition({ type: "close-requested", atMs: performance.now() });
      runtime = transition({ type: "closed", atMs: performance.now() });
    }
    issuedSession = null;
    void stageSession.clearCache().catch((error: unknown) => debug("brainpet.host", "stage cache release failed", { error: error instanceof Error ? error.message : String(error) }));
    info("brainpet.host", "stage closed");
  });

  startRepositionTimer();
  startStageHitTestTimer();

  const devUrl = getSafeRendererDevUrl();
  const load = devUrl
    ? window.loadURL(new URL("brainpet.html", devUrl).toString())
    : window.loadFile(join(app.getAppPath(), "dist", "renderer", "brainpet.html"));
  void load.catch((error: unknown) => {
    logError("brainpet.host", "stage load rejected", error);
    closeBrainPetStage("load-rejected");
  });
  info("brainpet.host", "stage opening", { bounds, mode: getStageMode() });
}

export function closeBrainPetStage(reason = "requested"): void {
  const window = stageWindow;
  if (!window || window.isDestroyed()) {
    stageWindow = null;
    return;
  }
  if (runtime.phase !== "closing" && runtime.phase !== "idle") runtime = transition({ type: "close-requested", atMs: performance.now() });
  info("brainpet.host", "stage close requested", { reason });
  if (stageAnchorWindow && !stageAnchorWindow.isDestroyed()) stageAnchorWindow.webContents.send("openpets:brainpet-stage-state", { open: false });
  window.close();
}

export async function shutdownBrainPetHost(): Promise<void> {
  brainPetHostEnabled = false;
  setBrainPetTrainingRequestHandler(null);
  setBrainPetDragLifecycleHandler(null);
  closeBrainPetStage("app-shutdown");
  stopRepositionTimer();
  stopStageHitTestTimer();
  clearRigSettleTimer();
  clearRigGeometryTimer();
  unbindStageAnchor();
  removeBrainPetHostEvents();
  await stateSaveChain.catch(() => undefined);
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
function handleResume(): void { sendPauseEvent("resume", "suspend"); reflowInteractionRig("resume"); }
function handleDisplayChange(): void { reflowInteractionRig("display-change"); }

function sendPauseEvent(type: "pause" | "resume", reason: "lock-screen" | "suspend"): void {
  const window = stageWindow;
  if (!window || window.isDestroyed()) return;
  info("brainpet.host", "host lifecycle event", { type, reason, runtimePhase: runtime.phase });
  window.webContents.send(STAGE_HOST_EVENT_CHANNEL, { type, reason });
}

function hardenStageSession(stageSession: Session): void {
  if (hardenedStageSessions.has(stageSession)) return;
  hardenedStageSessions.add(stageSession);
  stageSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  stageSession.on("will-download", (event) => event.preventDefault());
}

function handleAgentActivity(payload: Record<string, unknown>): void {
  const activity = parseBrainPetAgentActivity(payload);
  if (!activity || !isBrainPetAgentCompletion(activity)) return;
  const window = stageWindow;
  if (!window || window.isDestroyed()) return;
  debug("brainpet.host", "agent completion observed without interrupting stage", { surface: activity.surface, runtimePhase: runtime.phase });
  window.webContents.send(STAGE_HOST_EVENT_CHANNEL, { type: "agent-completed", surface: activity.surface });
}

export function getBrainPetRuntimeSnapshot(): BrainPetRuntimeSnapshot {
  return runtime;
}

function installBrainPetIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;

  ipcMain.handle(STAGE_BOOTSTRAP_CHANNEL, (event): BrainPetStageBootstrap => {
    assertStageSender(event);
    if (!interactionRig) throw new Error("BrainPet interaction rig is unavailable.");
    const suggestedSeed = createSeed(Date.now(), process.pid);
    const session = issuedSession ??= createNextSession(suggestedSeed);
    return {
      apiVersion: 1,
      mode: getStageMode(),
      suggestedSeed,
      session,
      availableTasks: getAvailableTasks(),
      lastResult: runtime.lastResult ?? persistedState.recentResults[0] ?? null,
      highScores: persistedState.highScores,
      levelHighScore: isPlayableBrainPetTaskId(session.taskId) ? persistedState.taskProgress[session.taskId].highScoresByLevel[String(session.level)] ?? 0 : 0,
      todayCompleted: persistedState.dailyCompletion.localDate === localDateKey(new Date()) ? persistedState.dailyCompletion.count : 0,
      petSpriteUrl: getCurrentPetSpriteUrl(),
      rig: interactionRig,
    };
  });
  ipcMain.handle(STAGE_NEXT_SESSION_CHANNEL, (event, value: unknown): BrainPetTaskSessionConfig => {
    assertStageSender(event);
    const completed = runtime.lastResult;
    if (runtime.phase !== "ready"
      || !completed
      || !isRecord(value)
      || value.taskId !== completed.taskId
      || value.level !== completed.level
      || (!isPlayableBrainPetTaskId(completed.taskId) && getStageMode() !== "stage-exerciser")) {
      throw new Error("BrainPet cannot issue the requested retry session in the current state.");
    }
    issuedSession = createSessionConfig(completed.taskId, createSeed(Date.now(), process.pid ^ completed.seed), completed.level);
    return issuedSession;
  });
  ipcMain.on(STAGE_READY_CHANNEL, (event) => {
    if (!isStageSender(event) || runtime.phase !== "opening") return;
    runtime = transition({ type: "stage-ready", atMs: performance.now() });
  });
  ipcMain.on(STAGE_CLOSE_CHANNEL, (event) => {
    if (!isStageSender(event)) return;
    closeBrainPetStage("renderer-requested");
  });
  ipcMain.on(STAGE_INTERACTIVE_CHANNEL, (event, interactive: unknown) => {
    if (!isStageSender(event) || typeof interactive !== "boolean") return;
    rendererRequestedInteractive = interactive;
    refreshStageMouseInteractivity();
  });
  ipcMain.on(PET_THROW_CHANNEL, (event, stimulusId: unknown) => {
    if (!isStageSender(event) || typeof stimulusId !== "string" || stimulusId.length === 0 || stimulusId.length > 128 || runtime.phase !== "running") return;
    const now = performance.now();
    if (now - lastPetThrowAt < 100) return;
    const anchor = stageAnchorWindow;
    const rig = interactionRig;
    if (!anchor || anchor.isDestroyed() || !rig) return;
    lastPetThrowAt = now;
    const petCenterX = rig.petBoundsScreen.x + rig.petBoundsScreen.width / 2;
    const reactionCenterX = rig.reactionBoundsScreen.x + rig.reactionBoundsScreen.width / 2;
    anchor.webContents.send("openpets:brainpet-throw", { stimulusId, direction: reactionCenterX < petCenterX ? "left" : "right" });
  });
  ipcMain.on(RIG_DRAG_START_CHANNEL, (event, point: unknown) => {
    if (!isStageSender(event) || !isBrainPetRigPointer(point)) return;
    beginRigDrag("stage", point);
  });
  ipcMain.on(RIG_DRAG_MOVE_CHANNEL, (event, point: unknown) => {
    if (!isStageSender(event) || !isBrainPetRigPointer(point)) return;
    moveStageRigDrag(point);
  });
  ipcMain.on(RIG_DRAG_END_CHANNEL, (event) => {
    if (!isStageSender(event)) return;
    endRigDrag("stage");
  });
  ipcMain.on(STAGE_EVENT_CHANNEL, (event, value: unknown) => {
    if (!isStageSender(event)) return;
    const parsed = parseRuntimeEvent(value);
    if (!parsed) {
      warn("brainpet.host", "invalid stage event rejected");
      return;
    }
    if ((parsed.type === "pause-requested" || parsed.type === "resume-requested") && runtime.phase === "closing") {
      debug("brainpet.host", "late stage lifecycle event ignored during close", { type: parsed.type });
      return;
    }
    try {
      runtime = transition(parsed);
      if (parsed.type === "settled") issuedSession = null;
      if (parsed.type === "session-finished") {
        const previousHigh = persistedState.highScores[parsed.result.taskId] ?? 0;
        const result = { ...parsed.result, petEvents: [...parsed.result.petEvents, ...(parsed.result.score > previousHigh ? ["new-best" as const] : [])] };
        runtime = { ...runtime, lastResult: result };
        const appended = appendBrainPetResult(persistedState, result);
        persistedState = appended.state;
        if (appended.outcome && stageWindow && !stageWindow.isDestroyed()) {
          stageWindow.webContents.send(STAGE_HOST_EVENT_CHANNEL, {
            type: "session-outcome",
            ...appended.outcome,
            todayCompleted: persistedState.dailyCompletion.count,
          });
        }
        if (appended.outcome?.passed && stageAnchorWindow && !stageAnchorWindow.isDestroyed()) {
          stageAnchorWindow.webContents.send("openpets:brainpet-accessory-feedback", {
            tone: appended.outcome.isNewLevelBest ? "new-best" : persistedState.dailyCompletion.count >= 2 ? "streak" : "clear",
          });
        }
        applyExternalPetReaction(result.petEvents.includes("new-best") || result.petEvents.includes("stable") ? "celebrating" : "success", { showMessage: false });
        if (statePath) {
          const snapshot = persistedState;
          stateSaveChain = stateSaveChain
            .catch(() => undefined)
            .then(() => saveBrainPetState(statePath!, snapshot))
            .catch((error: unknown) => logError("brainpet.host", "state save failed", error));
        }
      }
    } catch (error) {
      warn("brainpet.host", "stage event transition rejected", { error: error instanceof Error ? error.message : String(error), type: parsed.type });
    }
  });
}

function parseRuntimeEvent(value: unknown): BrainPetRuntimeEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const atMs = performance.now();
  if (value.type === "pause-requested" || value.type === "resume-requested" || value.type === "settled") return { type: value.type, atMs };
  if (value.type === "session-started" && isIssuedSession(value.session)) return { type: value.type, atMs, session: issuedSession! };
  if (value.type === "session-finished") {
    const result = parseResult(value.result);
    if (result) return { type: value.type, atMs, result };
  }
  return null;
}

function isIssuedSession(value: unknown): value is BrainPetTaskSessionConfig {
  return matchesIssuedBrainPetSession(issuedSession, value);
}

function parseResult(value: unknown): BrainPetTaskResult | null {
  if (!isRecord(value) || !isRegisteredBrainPetTaskId(value.taskId) || !issuedSession || value.taskId !== issuedSession.taskId || value.seed !== issuedSession.seed || value.level !== issuedSession.level) {
    warn("brainpet.host", "stage result rejected", { reason: "session-ownership" });
    return null;
  }
  const definition = getBrainPetTaskDefinition(value.taskId);
  const manifest = definition.manifest;
  if (!(Number.isInteger(value.seed)
    && Number.isFinite(value.score)
    && Number.isInteger(value.correct)
    && Number.isInteger(value.incorrect)
    && Number.isInteger(value.missed)
    && Number.isInteger(value.durationMs)
    && typeof value.startedAt === "string" && !Number.isNaN(Date.parse(value.startedAt as string))
    && typeof value.completedAt === "string"
    && value.completionStatus === "completed"
    && value.completedAt.length <= 64
    && typeof value.taskVersion === "string"
    && typeof value.assetVersion === "string"
    && value.difficultyPolicyVersion === "brainpet-block-v1"
    && typeof value.parameterVersion === "string"
    && isParameterVector(value.parameters)
    && value.blockCount === 3
    && value.scoreVersion === manifest.scoring.version
    && Number.isInteger(value.level)
    && Number.isInteger(value.falseAlarms)
    && (value.meanReactionTimeMs === null || Number.isFinite(value.meanReactionTimeMs))
    && Array.isArray(value.trials) && value.trials.length <= 256 && value.trials.every(isTrial)
    && isResultQuality(value.quality)
    && Array.isArray(value.petEvents) && value.petEvents.every((item) => item === "complete" || item === "stable" || item === "new-best"))) {
    warn("brainpet.host", "stage result rejected", { reason: "structural-contract", taskId: value.taskId, trialCount: Array.isArray(value.trials) ? value.trials.length : null });
    return null;
  }
  if (value.taskVersion !== manifest.taskVersion || value.assetVersion !== manifest.assetVersion || value.parameterVersion !== manifest.difficulty.parameterVersion || !parameterVectorsEqual(value.parameters as Record<string, number | string | boolean>, issuedSession.parameters)) {
    warn("brainpet.host", "stage result rejected", { reason: "version-or-parameters", taskId: value.taskId });
    return null;
  }
  const expectedKinds = definition.trialKindsForSession?.(issuedSession.seed, issuedSession.parameters);
  if (expectedKinds) {
    const trials = value.trials as Array<Record<string, unknown>>;
    const mismatchIndex = expectedKinds.findIndex((kind, index) => trials[index]?.stimulusKind !== kind);
    if (expectedKinds.length !== trials.length || mismatchIndex >= 0) {
      warn("brainpet.host", "stage result rejected", { reason: "trial-sequence", taskId: value.taskId, expectedCount: expectedKinds.length, actualCount: trials.length, mismatchIndex });
      return null;
    }
  }
  const result = canonicalizeBrainPetTaskResult(manifest, value as unknown as BrainPetTaskResult, definition.expectedInputForTrial);
  if (!result) warn("brainpet.host", "stage result rejected", { reason: "trial-evaluator", taskId: value.taskId });
  return result;
}

function isTrial(value: unknown): boolean {
  return isRecord(value)
    && typeof value.stimulusId === "string" && value.stimulusId.length <= 64
    && typeof value.stimulusKind === "string" && value.stimulusKind.length <= 64
    && (value.blockIndex === 1 || value.blockIndex === 2 || value.blockIndex === 3)
    && Number.isFinite(value.plannedAtMs)
    && Number.isFinite(value.presentedAtMs)
    && (value.inputType === "primary" || value.inputType === "secondary" || value.inputType === "none")
    && (value.inputAtMs === null || Number.isFinite(value.inputAtMs))
    && typeof value.correct === "boolean"
    && (value.reactionTimeMs === null || Number.isFinite(value.reactionTimeMs));
}

function isResultQuality(value: unknown): boolean {
  return isRecord(value)
    && typeof value.valid === "boolean"
    && Number.isInteger(value.focusLossCount) && (value.focusLossCount as number) >= 0
    && Number.isFinite(value.pausedMs) && (value.pausedMs as number) >= 0
    && Number.isInteger(value.droppedFrameCount) && (value.droppedFrameCount as number) >= 0
    && Number.isInteger(value.longFrameCount) && (value.longFrameCount as number) >= 0
    && Number.isFinite(value.maxFrameMs) && (value.maxFrameMs as number) >= 0
    && Array.isArray(value.flags)
    && value.flags.length <= 16
    && value.flags.every((flag) => typeof flag === "string" && flag.length <= 64);
}

function createInteractionRig(anchor: BrowserWindow): BrainPetInteractionRigSnapshot {
  const petBounds = anchor.getBounds();
  return createBrainPetInteractionRig({
    rigId: `brainpet-${anchor.id}-${Date.now()}`,
    petWindowId: anchor.id,
    petBounds,
    environment: environmentForBounds(petBounds),
    atMs: performance.now(),
  });
}

function bindStageAnchor(anchor: BrowserWindow): void {
  if (stageAnchorWindow === anchor && removeStageAnchorListeners) return;
  unbindStageAnchor();
  stageAnchorWindow = anchor;
  setPetWindowPositionLocked(anchor, true);
  const handleMove = () => scheduleInteractionRigSynchronization();
  const handleClosed = () => closeBrainPetStage("anchor-closed");
  anchor.on("move", handleMove);
  anchor.on("moved", handleMove);
  anchor.once("closed", handleClosed);
  removeStageAnchorListeners = () => {
    anchor.off("move", handleMove);
    anchor.off("moved", handleMove);
    anchor.off("closed", handleClosed);
    setPetWindowPositionLocked(anchor, false);
  };
}

function unbindStageAnchor(): void {
  removeStageAnchorListeners?.();
  removeStageAnchorListeners = null;
  stageAnchorWindow = null;
  anchorSyncScheduled = false;
}

function handlePetDragLifecycle(sourceWindow: BrowserWindow, phase: "start" | "end"): void {
  if (sourceWindow !== stageAnchorWindow) return;
  if (phase === "start") beginRigDrag("pet");
  else endRigDrag("pet");
}

function beginRigDrag(source: "pet" | "stage", startPointer?: BrainPetRigPointer, settleOnMovement = false): void {
  if (!interactionRig || rigDragTransaction) return;
  clearRigSettleTimer();
  const next = setBrainPetInteractionRigDragging(interactionRig, true, interactionRig.sequence + 1, performance.now());
  rigDragTransaction = { source, initial: next, settleOnMovement, ...(startPointer ? { startPointer } : {}) };
  applyInteractionRig(next, false, true);
  sendRigHostEvent({ type: "rig-drag-start", source, rig: next });
  debug("brainpet.runtime", "interaction rig drag started", { source, rigId: next.rigId, sequence: next.sequence });
}

function moveStageRigDrag(point: BrainPetRigPointer): void {
  const transaction = rigDragTransaction;
  if (!transaction || transaction.source !== "stage" || !transaction.startPointer) return;
  const next = translateBrainPetStageInRig(
    transaction.initial,
    { x: Math.round(point.screenX - transaction.startPointer.screenX), y: Math.round(point.screenY - transaction.startPointer.screenY) },
    environmentForPoint(point),
    { dragging: true, sequence: (interactionRig?.sequence ?? transaction.initial.sequence) + 1, atMs: performance.now() },
  );
  applyInteractionRig(next, false);
}

function endRigDrag(source: "pet" | "stage"): void {
  const transaction = rigDragTransaction;
  if (!transaction || transaction.source !== source) return;
  clearRigSettleTimer();
  rigSettleTimer = setTimeout(() => {
    rigSettleTimer = null;
    synchronizeInteractionRigFromPet(false);
    if (!interactionRig) return;
    const next = setBrainPetInteractionRigDragging(interactionRig, false, interactionRig.sequence + 1, performance.now());
    rigDragTransaction = null;
    applyInteractionRig(next, false, true);
    if (stageWindow && !stageWindow.isDestroyed()) stageWindow.focus();
    sendRigHostEvent({ type: "rig-drag-end", source, rig: next });
    debug("brainpet.runtime", "interaction rig drag settled", { source, rigId: next.rigId, sequence: next.sequence });
  }, 150);
  rigSettleTimer.unref?.();
}

function synchronizeInteractionRigFromPet(interruptUnexpectedMove = true): void {
  const anchor = stageAnchorWindow;
  const before = interactionRig;
  if (!anchor || anchor.isDestroyed() || !before) return;
  const petBounds = anchor.getBounds();
  if (rectanglesEqual(petBounds, before.petBoundsScreen)) return;
  const startedUnexpectedMove = !rigDragTransaction && interruptUnexpectedMove;
  if (startedUnexpectedMove) beginRigDrag("pet", undefined, true);
  const current = interactionRig ?? before;
  const next = reanchorBrainPetInteractionRig(current, petBounds, environmentForBounds(petBounds), {
    dragging: Boolean(rigDragTransaction),
    sequence: current.sequence + 1,
    atMs: performance.now(),
  });
  applyInteractionRig(next, false);
  if (rigDragTransaction?.source === "pet" && rigDragTransaction.settleOnMovement) endRigDrag("pet");
}

function scheduleInteractionRigSynchronization(): void {
  if (applyingRigBounds || anchorSyncScheduled) return;
  anchorSyncScheduled = true;
  setTimeout(() => {
    anchorSyncScheduled = false;
    synchronizeInteractionRigFromPet();
  }, 0).unref?.();
}

function reflowInteractionRig(reason: "display-change" | "resume"): void {
  const anchor = stageAnchorWindow;
  const before = interactionRig;
  if (!anchor || anchor.isDestroyed() || !before) return;
  sendRigHostEvent({ type: "rig-invalidated", reason, rig: before });
  clearRigSettleTimer();
  rigDragTransaction = null;
  beginRigDrag("pet", undefined, true);
  const current = interactionRig ?? before;
  const petBounds = anchor.getBounds();
  const next = reflowBrainPetInteractionRig(current, petBounds, environmentForBounds(petBounds), {
    dragging: true,
    sequence: current.sequence + 1,
    atMs: performance.now(),
  });
  applyInteractionRig(next, true, true);
  endRigDrag("pet");
}

function applyInteractionRig(next: BrainPetInteractionRigSnapshot, movePet: boolean, flushGeometry = false): void {
  interactionRig = next;
  const anchor = stageAnchorWindow;
  const window = stageWindow;
  applyingRigBounds = true;
  try {
    if (movePet && anchor && !anchor.isDestroyed() && !rectanglesEqual(anchor.getBounds(), next.petBoundsScreen)) {
      anchor.setBounds(next.petBoundsScreen, false);
    }
    if (window && !window.isDestroyed() && !rectanglesEqual(window.getContentBounds(), next.overlayBoundsScreen)) {
      window.setContentBounds(next.overlayBoundsScreen, false);
    }
  } finally {
    applyingRigBounds = false;
  }
  scheduleRigGeometryEvent(flushGeometry);
}

function scheduleRigGeometryEvent(flush = false): void {
  if (flush) {
    clearRigGeometryTimer();
    emitRigGeometry();
    return;
  }
  if (rigGeometryTimer) return;
  rigGeometryTimer = setTimeout(() => {
    rigGeometryTimer = null;
    emitRigGeometry();
  }, 34);
  rigGeometryTimer.unref?.();
}

function emitRigGeometry(): void {
  if (!interactionRig) return;
  sendRigHostEvent({ type: "rig-geometry-changed", rig: interactionRig });
}

function sendRigHostEvent(event: Record<string, unknown>): void {
  const window = stageWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send(STAGE_HOST_EVENT_CHANNEL, event);
}

function environmentForBounds(bounds: Electron.Rectangle): BrainPetRigEnvironment {
  const display = screen.getDisplayMatching(bounds);
  return { displayId: String(display.id), scaleFactor: display.scaleFactor, workArea: display.workArea };
}

function environmentForPoint(point: BrainPetRigPointer): BrainPetRigEnvironment {
  const display = screen.getDisplayNearestPoint({ x: Math.round(point.screenX), y: Math.round(point.screenY) });
  return { displayId: String(display.id), scaleFactor: display.scaleFactor, workArea: display.workArea };
}

function rectanglesEqual(left: Electron.Rectangle, right: Electron.Rectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function clearRigSettleTimer(): void {
  if (!rigSettleTimer) return;
  clearTimeout(rigSettleTimer);
  rigSettleTimer = null;
}

function clearRigGeometryTimer(): void {
  if (!rigGeometryTimer) return;
  clearTimeout(rigGeometryTimer);
  rigGeometryTimer = null;
}

function startRepositionTimer(): void {
  stopRepositionTimer();
  repositionTimer = setInterval(() => synchronizeInteractionRigFromPet(false), 1_000);
  repositionTimer.unref?.();
}

function stopRepositionTimer(): void {
  if (!repositionTimer) return;
  clearInterval(repositionTimer);
  repositionTimer = null;
}

function startStageHitTestTimer(): void {
  stopStageHitTestTimer();
  refreshStageMouseInteractivity();
  stageHitTestTimer = setInterval(refreshStageMouseInteractivity, 25);
  stageHitTestTimer.unref?.();
}

function stopStageHitTestTimer(): void {
  if (stageHitTestTimer) clearInterval(stageHitTestTimer);
  stageHitTestTimer = null;
  rendererRequestedInteractive = false;
  stageMouseInteractive = null;
}

function refreshStageMouseInteractivity(): void {
  const window = stageWindow;
  const rig = interactionRig;
  if (!window || window.isDestroyed() || !rig) return;
  const cursor = screen.getCursorScreenPoint();
  const stageInteractive = isBrainPetPointInsideRectangle(cursor, rig.stageBoundsScreen, 3);
  const interactive = rendererRequestedInteractive || stageInteractive;
  if (stageMouseInteractive === interactive) return;
  stageMouseInteractive = interactive;
  window.setIgnoreMouseEvents(!interactive, { forward: true });
}

function transition(event: BrainPetRuntimeEvent): BrainPetRuntimeSnapshot {
  const next = reduceBrainPetRuntime(runtime, event);
  debug("brainpet.runtime", "transition", { from: runtime.phase, to: next.phase, event: event.type });
  return next;
}

function getStageMode(): "stage-exerciser" | "training" {
  return process.env.OPENPETS_BRAINPET_EXERCISER === "1" ? "stage-exerciser" : "training";
}

function getAvailableTasks(): readonly BrainPetTaskResult["taskId"][] {
  const forced = process.env.OPENPETS_BRAINPET_FORCE_TASK;
  if (isPlayableBrainPetTaskId(forced) || getStageMode() === "stage-exerciser" && isRegisteredBrainPetTaskId(forced)) return [forced];
  return listPlayableBrainPetTaskIds();
}

function createNextSession(seed: number): BrainPetTaskSessionConfig {
  if (getStageMode() === "stage-exerciser") {
    const forced = process.env.OPENPETS_BRAINPET_FORCE_TASK;
    const manifest = getBrainPetTaskManifest(isRegisteredBrainPetTaskId(forced) ? forced : "stage-exerciser");
    return createSessionConfig(manifest.id, seed, 1);
  }
  const available = getAvailableTasks().filter(isPlayableBrainPetTaskId);
  const taskId = chooseBrainPetTask(available, seed, persistedState.recentTaskIds);
  const manifest = getBrainPetTaskManifest(taskId);
  return createSessionConfig(taskId, seed, persistedState.taskProgress[taskId].currentLevel);
}

function createSessionConfig(taskId: BrainPetTaskResult["taskId"], seed: number, level: number): BrainPetTaskSessionConfig {
  const manifest = getBrainPetTaskManifest(taskId);
  return { taskId, seed, durationMs: manifest.durationMs, level, difficultyPolicyVersion: manifest.difficulty.policyVersion, parameterVersion: manifest.difficulty.parameterVersion, parameters: getBrainPetDifficultyParameters(taskId, level), blockCount: manifest.difficulty.blockCount };
}

function getCurrentPetSpriteUrl(): string | null {
  const state = getAppStateSnapshot();
  const pet = state.pets.installed.find((candidate) => candidate.id === state.preferences.defaultPetId);
  if (!pet || pet.builtIn) return null;
  const scheme = pet.source?.kind === "codex" ? "openpets-codex" : "openpets-installed";
  return `${scheme}://spritesheet/${encodeURIComponent(pet.id)}`;
}

function isParameterVector(value: unknown): value is Record<string, number | string | boolean> {
  return isRecord(value) && Object.keys(value).length <= 16 && Object.entries(value).every(([key, item]) => /^[a-z][A-Za-z0-9]{0,31}$/.test(key) && (typeof item === "number" && Number.isFinite(item) || typeof item === "string" && item.length <= 64 || typeof item === "boolean"));
}

function parameterVectorsEqual(left: Record<string, number | string | boolean>, right: Readonly<Record<string, number | string | boolean>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function getSafeRendererDevUrl(): string | undefined {
  const raw = process.env.OPENPETS_RENDERER_URL;
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function assertStageSender(event: Electron.IpcMainInvokeEvent): void {
  if (!isStageSender(event)) throw new Error("BrainPet IPC sender is not the active stage.");
}

function isStageSender(event: Pick<IpcMainEvent, "sender">): boolean {
  return Boolean(stageWindow && !stageWindow.isDestroyed() && event.sender === stageWindow.webContents);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
