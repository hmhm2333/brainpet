import { app, BrowserWindow, ipcMain, powerMonitor, screen, type IpcMainEvent } from "electron";
import { join } from "node:path";

import { applyExternalPetReaction, getDefaultPetWindowForPlugins } from "../default-pet-controller.js";
import { debug, error as logError, info, warn } from "../logger.js";
import { setBrainPetTrainingRequestHandler } from "../pet-window.js";
import { computeBrainPetStageBounds } from "./geometry.js";
import { createBrainPetRuntimeSnapshot, createSeed, reduceBrainPetRuntime, type BrainPetRuntimeEvent, type BrainPetRuntimeSnapshot } from "./runtime-core.js";
import { computeDeclaredScore, isTaskId, type BrainPetTaskResult, type BrainPetTaskSessionConfig } from "./task-contract.js";
import { getBrainPetTaskManifest, isPlayableBrainPetTaskId, listPlayableBrainPetTaskIds } from "./task-registry.js";
import { appendBrainPetResult, createBrainPetPersistedState, loadBrainPetState, saveBrainPetState, type BrainPetPersistedState } from "./state.js";

const STAGE_READY_CHANNEL = "brainpet:stage-ready";
const STAGE_EVENT_CHANNEL = "brainpet:stage-event";
const STAGE_CLOSE_CHANNEL = "brainpet:stage-close";
const STAGE_BOOTSTRAP_CHANNEL = "brainpet:stage-bootstrap";
const STAGE_HOST_EVENT_CHANNEL = "brainpet:host-event";

let stageWindow: BrowserWindow | null = null;
let runtime: BrainPetRuntimeSnapshot = createBrainPetRuntimeSnapshot();
let ipcInstalled = false;
let repositionTimer: NodeJS.Timeout | null = null;
let stageAnchorWindow: BrowserWindow | null = null;
let statePath: string | null = null;
let persistedState: BrainPetPersistedState = createBrainPetPersistedState();
let stateSaveChain: Promise<void> = Promise.resolve();
let hostEventsInstalled = false;

export interface BrainPetStageBootstrap {
  readonly apiVersion: 1;
  readonly mode: "stage-exerciser" | "training";
  readonly suggestedSeed: number;
  readonly availableTasks: readonly BrainPetTaskResult["taskId"][];
  readonly lastResult: BrainPetTaskResult | null;
  readonly highScores: BrainPetPersistedState["highScores"];
}

export function initializeBrainPetHost(): void {
  if (!isBrainPetEnabled()) {
    info("brainpet.host", "disabled by environment");
    return;
  }
  installBrainPetIpc();
  installBrainPetHostEvents();
  statePath = join(app.getPath("userData"), "brainpet-state.json");
  persistedState = loadBrainPetState(statePath);
  setBrainPetTrainingRequestHandler((sourceWindow) => openBrainPetStage(sourceWindow));
  info("brainpet.host", "initialized");
}

export function openBrainPetStage(anchorWindow?: BrowserWindow): void {
  if (!isBrainPetEnabled()) return;
  const current = stageWindow;
  if (current && !current.isDestroyed()) {
    if (anchorWindow && !anchorWindow.isDestroyed()) stageAnchorWindow = anchorWindow;
    repositionBrainPetStage();
    if (current.isMinimized()) current.restore();
    current.show();
    current.focus();
    return;
  }

  stageAnchorWindow = anchorWindow && !anchorWindow.isDestroyed() ? anchorWindow : getDefaultPetWindowForPlugins();
  runtime = transition({ type: "open-requested", atMs: performance.now() });
  const bounds = computeCurrentStageBounds();
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
      preload: join(app.getAppPath(), "brainpet-preload.cjs"),
    },
  });

  stageWindow = window;
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
    repositionBrainPetStage();
    window.show();
    window.focus();
  });
  window.on("closed", () => {
    if (stageWindow === window) stageWindow = null;
    stageAnchorWindow = null;
    stopRepositionTimer();
    if (runtime.phase !== "idle") {
      if (runtime.phase !== "closing") runtime = transition({ type: "close-requested", atMs: performance.now() });
      runtime = transition({ type: "closed", atMs: performance.now() });
    }
    info("brainpet.host", "stage closed");
  });

  const petWindow = stageAnchorWindow;
  petWindow?.on("move", scheduleReposition);
  petWindow?.on("moved", scheduleReposition);
  window.on("closed", () => {
    petWindow?.off("move", scheduleReposition);
    petWindow?.off("moved", scheduleReposition);
  });
  startRepositionTimer();

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
  window.close();
}

export async function shutdownBrainPetHost(): Promise<void> {
  setBrainPetTrainingRequestHandler(null);
  closeBrainPetStage("app-shutdown");
  stopRepositionTimer();
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
}

function handleLockScreen(): void { sendHostEvent("pause", "lock-screen"); }
function handleUnlockScreen(): void { sendHostEvent("resume", "lock-screen"); }
function handleSuspend(): void { sendHostEvent("pause", "suspend"); }
function handleResume(): void { sendHostEvent("resume", "suspend"); repositionBrainPetStage(); }
function handleDisplayChange(): void { repositionBrainPetStage(); }

function sendHostEvent(type: "pause" | "resume", reason: "lock-screen" | "suspend"): void {
  const window = stageWindow;
  if (!window || window.isDestroyed()) return;
  window.webContents.send(STAGE_HOST_EVENT_CHANNEL, { type, reason });
}

export function getBrainPetRuntimeSnapshot(): BrainPetRuntimeSnapshot {
  return runtime;
}

function installBrainPetIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;

  ipcMain.handle(STAGE_BOOTSTRAP_CHANNEL, (event): BrainPetStageBootstrap => {
    assertStageSender(event);
    return {
      apiVersion: 1,
      mode: getStageMode(),
      suggestedSeed: createSeed(Date.now(), process.pid),
      availableTasks: getAvailableTasks(),
      lastResult: runtime.lastResult ?? persistedState.recentResults[0] ?? null,
      highScores: persistedState.highScores,
    };
  });
  ipcMain.on(STAGE_READY_CHANNEL, (event) => {
    if (!isStageSender(event) || runtime.phase !== "opening") return;
    runtime = transition({ type: "stage-ready", atMs: performance.now() });
  });
  ipcMain.on(STAGE_CLOSE_CHANNEL, (event) => {
    if (!isStageSender(event)) return;
    closeBrainPetStage("renderer-requested");
  });
  ipcMain.on(STAGE_EVENT_CHANNEL, (event, value: unknown) => {
    if (!isStageSender(event)) return;
    const parsed = parseRuntimeEvent(value);
    if (!parsed) {
      warn("brainpet.host", "invalid stage event rejected");
      return;
    }
    try {
      runtime = transition(parsed);
      if (parsed.type === "session-finished") {
        persistedState = appendBrainPetResult(persistedState, parsed.result);
        applyExternalPetReaction(parsed.result.petEvents.includes("new-best") || parsed.result.petEvents.includes("stable") ? "celebrating" : "success");
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
  if (value.type === "session-started" && isSession(value.session)) return { type: value.type, atMs, session: value.session };
  if (value.type === "session-finished" && isResult(value.result)) return { type: value.type, atMs, result: value.result };
  return null;
}

function isSession(value: unknown): value is BrainPetTaskSessionConfig {
  if (!isRecord(value) || !isTaskId(value.taskId)) return false;
  return Number.isInteger(value.seed) && Number.isInteger(value.durationMs) && (value.durationMs as number) >= 10_000 && (value.durationMs as number) <= 120_000 && Number.isInteger(value.level) && (value.level as number) >= 1 && (value.level as number) <= 100 && value.difficultyPolicyVersion === "brainpet-block-v1";
}

function isResult(value: unknown): value is BrainPetTaskResult {
  if (!isRecord(value) || !isTaskId(value.taskId)) return false;
  if (!(Number.isInteger(value.seed)
    && Number.isFinite(value.score)
    && Number.isInteger(value.correct)
    && Number.isInteger(value.incorrect)
    && Number.isInteger(value.missed)
    && Number.isInteger(value.durationMs)
    && typeof value.completedAt === "string"
    && value.completedAt.length <= 64
    && typeof value.taskVersion === "string"
    && typeof value.assetVersion === "string"
    && value.difficultyPolicyVersion === "brainpet-block-v1"
    && value.scoreVersion === "brainpet-score-v1"
    && Number.isInteger(value.level)
    && Number.isInteger(value.falseAlarms)
    && (value.meanReactionTimeMs === null || Number.isFinite(value.meanReactionTimeMs))
    && Array.isArray(value.trials) && value.trials.length <= 256 && value.trials.every(isTrial)
    && isResultQuality(value.quality)
    && Array.isArray(value.petEvents) && value.petEvents.every((item) => item === "complete" || item === "stable" || item === "new-best"))) return false;
  const manifest = getBrainPetTaskManifest(value.taskId);
  if (value.taskVersion !== manifest.taskVersion || value.assetVersion !== manifest.assetVersion) return false;
  const trials = value.trials as BrainPetTaskResult["trials"];
  const correct = trials.filter((trial) => isRecord(trial) && trial.correct === true).length;
  const incorrect = trials.filter((trial) => isRecord(trial) && trial.correct === false && trial.inputType !== "none").length;
  const missed = trials.filter((trial) => isRecord(trial) && trial.correct === false && trial.inputType === "none").length;
  const falseAlarms = trials.filter((trial) => trial.stimulusKind === "no-go" && trial.correct === false && trial.inputType !== "none").length;
  const reactionTimes = trials.flatMap((trial) => trial.reactionTimeMs === null ? [] : [trial.reactionTimeMs]);
  const meanReactionTimeMs = reactionTimes.length === 0 ? null : Math.round(reactionTimes.reduce((total, item) => total + item, 0) / reactionTimes.length);
  return value.correct === correct
    && value.incorrect === incorrect
    && value.missed === missed
    && value.falseAlarms === falseAlarms
    && value.meanReactionTimeMs === meanReactionTimeMs
    && value.score === computeDeclaredScore(manifest, trials);
}

function isTrial(value: unknown): boolean {
  return isRecord(value)
    && typeof value.stimulusId === "string" && value.stimulusId.length <= 64
    && typeof value.stimulusKind === "string" && value.stimulusKind.length <= 64
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
    && Number.isInteger(value.focusLossCount)
    && Number.isFinite(value.pausedMs)
    && Number.isInteger(value.droppedFrameCount)
    && Number.isInteger(value.longFrameCount)
    && Number.isFinite(value.maxFrameMs)
    && Array.isArray(value.flags)
    && value.flags.length <= 16
    && value.flags.every((flag) => typeof flag === "string" && flag.length <= 64);
}

function computeCurrentStageBounds(): Electron.Rectangle {
  const petWindow = stageAnchorWindow && !stageAnchorWindow.isDestroyed() ? stageAnchorWindow : getDefaultPetWindowForPlugins();
  const petBounds = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : undefined;
  const display = petBounds ? screen.getDisplayMatching(petBounds) : screen.getPrimaryDisplay();
  const fallbackPet = {
    x: display.workArea.x + display.workArea.width - 160,
    y: display.workArea.y + display.workArea.height - 160,
    width: 140,
    height: 140,
  };
  return computeBrainPetStageBounds(petBounds ?? fallbackPet, display.workArea);
}

function repositionBrainPetStage(): void {
  const window = stageWindow;
  if (!window || window.isDestroyed()) return;
  window.setContentBounds(computeCurrentStageBounds(), false);
}

function scheduleReposition(): void {
  setTimeout(repositionBrainPetStage, 0).unref?.();
}

function startRepositionTimer(): void {
  stopRepositionTimer();
  repositionTimer = setInterval(repositionBrainPetStage, 1_000);
  repositionTimer.unref?.();
}

function stopRepositionTimer(): void {
  if (!repositionTimer) return;
  clearInterval(repositionTimer);
  repositionTimer = null;
}

function transition(event: BrainPetRuntimeEvent): BrainPetRuntimeSnapshot {
  const next = reduceBrainPetRuntime(runtime, event);
  debug("brainpet.runtime", "transition", { from: runtime.phase, to: next.phase, event: event.type });
  return next;
}

function isBrainPetEnabled(): boolean {
  return process.env.OPENPETS_BRAINPET_ENABLED !== "0";
}

function getStageMode(): "stage-exerciser" | "training" {
  return process.env.OPENPETS_BRAINPET_EXERCISER === "1" ? "stage-exerciser" : "training";
}

function getAvailableTasks(): readonly BrainPetTaskResult["taskId"][] {
  const forced = process.env.OPENPETS_BRAINPET_FORCE_TASK;
  if (isPlayableBrainPetTaskId(forced)) return [forced];
  return listPlayableBrainPetTaskIds();
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
