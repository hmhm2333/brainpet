import type { BrainPetTaskId, BrainPetTaskResult, BrainPetTaskSessionConfig } from "./task-contract.js";

export type BrainPetRuntimePhase = "idle" | "opening" | "ready" | "running" | "paused" | "settling" | "closing";

export interface BrainPetRuntimeSnapshot {
  readonly phase: BrainPetRuntimePhase;
  readonly session: BrainPetTaskSessionConfig | null;
  readonly openedAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly pauseStartedAtMs: number | null;
  readonly pausedDurationMs: number;
  readonly lastResult: BrainPetTaskResult | null;
}

export type BrainPetRuntimeEvent =
  | { readonly type: "open-requested"; readonly atMs: number }
  | { readonly type: "stage-ready"; readonly atMs: number }
  | { readonly type: "session-started"; readonly atMs: number; readonly session: BrainPetTaskSessionConfig }
  | { readonly type: "pause-requested"; readonly atMs: number }
  | { readonly type: "resume-requested"; readonly atMs: number }
  | { readonly type: "session-finished"; readonly atMs: number; readonly result: BrainPetTaskResult }
  | { readonly type: "settled"; readonly atMs: number }
  | { readonly type: "close-requested"; readonly atMs: number }
  | { readonly type: "closed"; readonly atMs: number };

export function createBrainPetRuntimeSnapshot(): BrainPetRuntimeSnapshot {
  return {
    phase: "idle",
    session: null,
    openedAtMs: null,
    startedAtMs: null,
    pauseStartedAtMs: null,
    pausedDurationMs: 0,
    lastResult: null,
  };
}

export function reduceBrainPetRuntime(
  state: BrainPetRuntimeSnapshot,
  event: BrainPetRuntimeEvent,
): BrainPetRuntimeSnapshot {
  switch (event.type) {
    case "open-requested":
      requirePhase(state, "idle", event.type);
      return { ...createBrainPetRuntimeSnapshot(), phase: "opening", openedAtMs: event.atMs, lastResult: state.lastResult };
    case "stage-ready":
      requirePhase(state, "opening", event.type);
      return { ...state, phase: "ready" };
    case "session-started":
      requirePhase(state, "ready", event.type);
      return { ...state, phase: "running", session: event.session, startedAtMs: event.atMs, pauseStartedAtMs: null, pausedDurationMs: 0 };
    case "pause-requested":
      requirePhase(state, "running", event.type);
      return { ...state, phase: "paused", pauseStartedAtMs: event.atMs };
    case "resume-requested": {
      requirePhase(state, "paused", event.type);
      const pauseStartedAtMs = state.pauseStartedAtMs ?? event.atMs;
      return { ...state, phase: "running", pauseStartedAtMs: null, pausedDurationMs: state.pausedDurationMs + Math.max(0, event.atMs - pauseStartedAtMs) };
    }
    case "session-finished":
      if (state.phase !== "running" && state.phase !== "paused") throw invalidTransition(state, event.type);
      if (state.session?.taskId !== event.result.taskId || state.session.seed !== event.result.seed) {
        throw new Error("BrainPet result does not match the active session.");
      }
      return { ...state, phase: "settling", pauseStartedAtMs: null, lastResult: event.result };
    case "settled":
      requirePhase(state, "settling", event.type);
      return { ...state, phase: "ready", session: null, startedAtMs: null, pauseStartedAtMs: null, pausedDurationMs: 0 };
    case "close-requested":
      if (state.phase === "idle" || state.phase === "closing") throw invalidTransition(state, event.type);
      return { ...state, phase: "closing" };
    case "closed":
      requirePhase(state, "closing", event.type);
      return { ...createBrainPetRuntimeSnapshot(), lastResult: state.lastResult };
  }
}

export function createSeed(nowMs: number, salt = 0): number {
  const normalized = (Math.trunc(nowMs) ^ Math.trunc(salt) ^ 0x9e3779b9) >>> 0;
  return normalized === 0 ? 1 : normalized;
}

export function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function pickBrainPetTask(seed: number, taskIds: readonly BrainPetTaskId[]): BrainPetTaskId {
  if (taskIds.length === 0) throw new Error("At least one BrainPet task is required.");
  const random = createDeterministicRandom(seed);
  return taskIds[Math.floor(random() * taskIds.length)]!;
}

function requirePhase(state: BrainPetRuntimeSnapshot, phase: BrainPetRuntimePhase, eventType: BrainPetRuntimeEvent["type"]): void {
  if (state.phase !== phase) throw invalidTransition(state, eventType);
}

function invalidTransition(state: BrainPetRuntimeSnapshot, eventType: BrainPetRuntimeEvent["type"]): Error {
  return new Error(`Invalid BrainPet runtime transition: ${state.phase} -> ${eventType}.`);
}
