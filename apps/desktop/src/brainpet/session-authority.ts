import { debug, error as logError, warn } from "../logger.js";
import { chooseBrainPetTask, localDateKey } from "./progression.js";
import { createBrainPetRuntimeSnapshot, createSeed, reduceBrainPetRuntime, type BrainPetRuntimeEvent, type BrainPetRuntimeSnapshot } from "./runtime-core.js";
import { canonicalizeBrainPetTaskResult, type BrainPetTaskResult, type BrainPetTaskSessionConfig } from "./task-contract.js";
import { getBrainPetDifficultyParameters, getBrainPetTaskDefinition, getBrainPetTaskManifest, isPlayableBrainPetTaskId, isRegisteredBrainPetTaskId, listPlayableBrainPetTaskIds } from "./task-registry.js";
import { appendBrainPetResult, createBrainPetPersistedState, loadBrainPetState, saveBrainPetState, type BrainPetPersistedState } from "./state.js";
import { matchesIssuedBrainPetSession } from "./session-ownership.js";
import type { BrainPetInteractionRigSnapshot } from "./interaction-rig.js";

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

export interface BrainPetSessionAuthorityCallbacks {
  readonly emitStageEvent: (event: Record<string, unknown>) => void;
  readonly emitAccessoryFeedback: (tone: "new-best" | "streak" | "clear") => void;
  readonly applyPetReaction: (reaction: "celebrating" | "success") => void;
}

export interface BrainPetSessionAuthorityOptions extends BrainPetSessionAuthorityCallbacks {
  readonly statePath?: string | null;
  readonly initialState?: BrainPetPersistedState;
  readonly now?: () => number;
  readonly wallClock?: () => number;
  readonly processId?: number;
  readonly persistState?: (path: string, state: BrainPetPersistedState) => Promise<void>;
}

export class BrainPetSessionAuthority {
  private runtime: BrainPetRuntimeSnapshot = createBrainPetRuntimeSnapshot();
  private persistedState: BrainPetPersistedState;
  private issuedSession: BrainPetTaskSessionConfig | null = null;
  private stateSaveChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly statePath: string | null;
  private readonly now: () => number;
  private readonly wallClock: () => number;
  private readonly processId: number;
  private readonly persistState: (path: string, state: BrainPetPersistedState) => Promise<void>;

  constructor(private readonly callbacks: BrainPetSessionAuthorityOptions) {
    this.statePath = callbacks.statePath ?? null;
    this.persistedState = callbacks.initialState
      ?? (this.statePath ? loadBrainPetState(this.statePath, (message) => warn("brainpet.host", message)) : createBrainPetPersistedState());
    this.now = callbacks.now ?? (() => performance.now());
    this.wallClock = callbacks.wallClock ?? (() => Date.now());
    this.processId = callbacks.processId ?? process.pid;
    this.persistState = callbacks.persistState ?? saveBrainPetState;
  }

  get snapshot(): BrainPetRuntimeSnapshot {
    return this.runtime;
  }

  get phase(): BrainPetRuntimeSnapshot["phase"] {
    return this.runtime.phase;
  }

  beginOpen(): void {
    this.assertActive();
    this.runtime = this.transition({ type: "open-requested", atMs: this.now() });
  }

  stageReady(): void {
    if (this.disposed || this.runtime.phase !== "opening") return;
    this.runtime = this.transition({ type: "stage-ready", atMs: this.now() });
  }

  beginClose(): void {
    if (this.disposed || this.runtime.phase === "closing" || this.runtime.phase === "idle") return;
    this.runtime = this.transition({ type: "close-requested", atMs: this.now() });
  }

  stageClosed(): void {
    if (this.runtime.phase !== "idle") {
      if (this.runtime.phase !== "closing") this.runtime = this.transition({ type: "close-requested", atMs: this.now() });
      this.runtime = this.transition({ type: "closed", atMs: this.now() });
    }
    this.issuedSession = null;
  }

  createBootstrap(rig: BrainPetInteractionRigSnapshot, petSpriteUrl: string | null): BrainPetStageBootstrap {
    this.assertActive();
    const suggestedSeed = createSeed(this.wallClock(), this.processId);
    const session = this.issuedSession ??= this.createNextSession(suggestedSeed);
    return {
      apiVersion: 1,
      mode: getStageMode(),
      suggestedSeed,
      session,
      availableTasks: getAvailableTasks(),
      lastResult: this.runtime.lastResult ?? this.persistedState.recentResults[0] ?? null,
      highScores: this.persistedState.highScores,
      levelHighScore: isPlayableBrainPetTaskId(session.taskId) ? this.persistedState.taskProgress[session.taskId].highScoresByLevel[String(session.level)] ?? 0 : 0,
      todayCompleted: this.persistedState.dailyCompletion.localDate === localDateKey(new Date(this.wallClock())) ? this.persistedState.dailyCompletion.count : 0,
      petSpriteUrl,
      rig,
    };
  }

  issueRetry(value: unknown): BrainPetTaskSessionConfig {
    this.assertActive();
    const completed = this.runtime.lastResult;
    if (this.runtime.phase !== "ready"
      || !completed
      || !isRecord(value)
      || value.taskId !== completed.taskId
      || value.level !== completed.level
      || (!isPlayableBrainPetTaskId(completed.taskId) && getStageMode() !== "stage-exerciser")) {
      throw new Error("BrainPet cannot issue the requested retry session in the current state.");
    }
    this.issuedSession = createSessionConfig(completed.taskId, createSeed(this.wallClock(), this.processId ^ completed.seed), completed.level);
    return this.issuedSession;
  }

  handleStageEvent(value: unknown): void {
    if (this.disposed) return;
    const parsed = this.parseRuntimeEvent(value);
    if (!parsed) {
      warn("brainpet.host", "invalid stage event rejected");
      return;
    }
    if ((parsed.type === "pause-requested" || parsed.type === "resume-requested") && this.runtime.phase === "closing") {
      debug("brainpet.host", "late stage lifecycle event ignored during close", { type: parsed.type });
      return;
    }
    try {
      this.runtime = this.transition(parsed);
      if (parsed.type === "settled") this.issuedSession = null;
      if (parsed.type === "session-finished") this.acceptFinishedSession(parsed.result);
    } catch (error) {
      warn("brainpet.host", "stage event transition rejected", { error: error instanceof Error ? error.message : String(error), type: parsed.type });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stageClosed();
    await this.stateSaveChain.catch(() => undefined);
  }

  private acceptFinishedSession(parsedResult: BrainPetTaskResult): void {
    const previousHigh = this.persistedState.highScores[parsedResult.taskId] ?? 0;
    const result = { ...parsedResult, petEvents: [...parsedResult.petEvents, ...(parsedResult.score > previousHigh ? ["new-best" as const] : [])] };
    this.runtime = { ...this.runtime, lastResult: result };
    const appended = appendBrainPetResult(this.persistedState, result);
    this.persistedState = appended.state;
    if (appended.outcome) {
      this.callbacks.emitStageEvent({ type: "session-outcome", ...appended.outcome, todayCompleted: this.persistedState.dailyCompletion.count });
    }
    if (appended.outcome?.passed) {
      this.callbacks.emitAccessoryFeedback(appended.outcome.isNewLevelBest ? "new-best" : this.persistedState.dailyCompletion.count >= 2 ? "streak" : "clear");
    }
    this.callbacks.applyPetReaction(result.petEvents.includes("new-best") || result.petEvents.includes("stable") ? "celebrating" : "success");
    if (this.statePath) {
      const snapshot = this.persistedState;
      this.stateSaveChain = this.stateSaveChain
        .catch(() => undefined)
        .then(() => this.persistState(this.statePath!, snapshot))
        .catch((error: unknown) => logError("brainpet.host", "state save failed", error));
    }
  }

  private parseRuntimeEvent(value: unknown): BrainPetRuntimeEvent | null {
    if (!isRecord(value) || typeof value.type !== "string") return null;
    const atMs = this.now();
    if (value.type === "pause-requested" || value.type === "resume-requested" || value.type === "settled") return { type: value.type, atMs };
    if (value.type === "session-started" && matchesIssuedBrainPetSession(this.issuedSession, value.session)) return { type: value.type, atMs, session: this.issuedSession! };
    if (value.type === "session-finished") {
      const result = this.parseResult(value.result);
      if (result) return { type: value.type, atMs, result };
    }
    return null;
  }

  private parseResult(value: unknown): BrainPetTaskResult | null {
    const issuedSession = this.issuedSession;
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
      && typeof value.startedAt === "string" && !Number.isNaN(Date.parse(value.startedAt))
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
    if (value.taskVersion !== manifest.taskVersion || value.assetVersion !== manifest.assetVersion || value.parameterVersion !== manifest.difficulty.parameterVersion || !parameterVectorsEqual(value.parameters, issuedSession.parameters)) {
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

  private createNextSession(seed: number): BrainPetTaskSessionConfig {
    if (getStageMode() === "stage-exerciser") {
      const forced = process.env.OPENPETS_BRAINPET_FORCE_TASK;
      const manifest = getBrainPetTaskManifest(isRegisteredBrainPetTaskId(forced) ? forced : "stage-exerciser");
      return createSessionConfig(manifest.id, seed, 1);
    }
    const available = getAvailableTasks().filter(isPlayableBrainPetTaskId);
    const taskId = chooseBrainPetTask(available, seed, this.persistedState.recentTaskIds);
    const manifest = getBrainPetTaskManifest(taskId);
    return createSessionConfig(taskId, seed, this.persistedState.taskProgress[taskId].currentLevel);
  }

  private transition(event: BrainPetRuntimeEvent): BrainPetRuntimeSnapshot {
    const next = reduceBrainPetRuntime(this.runtime, event);
    debug("brainpet.runtime", "transition", { from: this.runtime.phase, to: next.phase, event: event.type });
    return next;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("BrainPet SessionAuthority is disposed.");
  }
}

function getStageMode(): "stage-exerciser" | "training" {
  return process.env.OPENPETS_BRAINPET_EXERCISER === "1" ? "stage-exerciser" : "training";
}

function getAvailableTasks(): readonly BrainPetTaskResult["taskId"][] {
  const forced = process.env.OPENPETS_BRAINPET_FORCE_TASK;
  if (isPlayableBrainPetTaskId(forced) || getStageMode() === "stage-exerciser" && isRegisteredBrainPetTaskId(forced)) return [forced];
  return listPlayableBrainPetTaskIds();
}

function createSessionConfig(taskId: BrainPetTaskResult["taskId"], seed: number, level: number): BrainPetTaskSessionConfig {
  const manifest = getBrainPetTaskManifest(taskId);
  return { taskId, seed, durationMs: manifest.durationMs, level, difficultyPolicyVersion: manifest.difficulty.policyVersion, parameterVersion: manifest.difficulty.parameterVersion, parameters: getBrainPetDifficultyParameters(taskId, level), blockCount: manifest.difficulty.blockCount };
}

function isParameterVector(value: unknown): value is Record<string, number | string | boolean> {
  return isRecord(value) && Object.keys(value).length <= 16 && Object.entries(value).every(([key, item]) => /^[a-z][A-Za-z0-9]{0,31}$/.test(key) && (typeof item === "number" && Number.isFinite(item) || typeof item === "string" && item.length <= 64 || typeof item === "boolean"));
}

function parameterVectorsEqual(left: Record<string, number | string | boolean>, right: Readonly<Record<string, number | string | boolean>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
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
    && typeof value.focusLossCount === "number" && Number.isInteger(value.focusLossCount) && value.focusLossCount >= 0
    && typeof value.pausedMs === "number" && Number.isFinite(value.pausedMs) && value.pausedMs >= 0
    && typeof value.droppedFrameCount === "number" && Number.isInteger(value.droppedFrameCount) && value.droppedFrameCount >= 0
    && typeof value.longFrameCount === "number" && Number.isInteger(value.longFrameCount) && value.longFrameCount >= 0
    && typeof value.maxFrameMs === "number" && Number.isFinite(value.maxFrameMs) && value.maxFrameMs >= 0
    && Array.isArray(value.flags)
    && value.flags.length <= 16
    && value.flags.every((flag) => typeof flag === "string" && flag.length <= 64);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
