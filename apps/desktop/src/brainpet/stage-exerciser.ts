import { createBrainPetRuntimeSnapshot, createDeterministicRandom, reduceBrainPetRuntime } from "./runtime-core.js";
import type { BrainPetTaskId, BrainPetTaskResult } from "./task-contract.js";

export interface BrainPetExerciseReport {
  readonly cycles: number;
  readonly virtualDurationMs: number;
  readonly moduleSwitches: number;
  readonly crashesRecovered: number;
  readonly finalPhase: "idle";
  readonly deterministicChecksum: number;
}

export function runBrainPetStageExercise(options: {
  readonly cycles: number;
  readonly virtualDurationMs: number;
  readonly crashEvery?: number;
}): BrainPetExerciseReport {
  if (!Number.isInteger(options.cycles) || options.cycles < 1 || options.cycles > 10_000) throw new Error("Exercise cycles must be between 1 and 10000.");
  if (!Number.isInteger(options.virtualDurationMs) || options.virtualDurationMs < 1_000) throw new Error("Exercise duration must be at least one second.");
  let now = 0;
  let state = createBrainPetRuntimeSnapshot();
  let moduleSwitches = 0;
  let crashesRecovered = 0;
  let checksum = 0;
  let previousTask: BrainPetTaskId | null = null;

  for (let cycle = 0; cycle < options.cycles; cycle += 1) {
    const taskId: BrainPetTaskId = cycle % 2 === 0 ? "cargo-signal" : "pack-refresh";
    if (previousTask && previousTask !== taskId) moduleSwitches += 1;
    previousTask = taskId;
    const seed = cycle + 1;
    const random = createDeterministicRandom(seed);
    state = reduceBrainPetRuntime(state, { type: "open-requested", atMs: now++ });
    state = reduceBrainPetRuntime(state, { type: "stage-ready", atMs: now++ });
    state = reduceBrainPetRuntime(state, { type: "session-started", atMs: now++, session: { taskId, seed, durationMs: 45_000, level: 1 } });
    checksum = (checksum + Math.floor(random() * 1_000_000)) >>> 0;
    const shouldCrash = Boolean(options.crashEvery && (cycle + 1) % options.crashEvery === 0);
    if (shouldCrash) {
      crashesRecovered += 1;
      state = reduceBrainPetRuntime(state, { type: "close-requested", atMs: now++ });
      state = reduceBrainPetRuntime(state, { type: "closed", atMs: now++ });
      continue;
    }
    const result: BrainPetTaskResult = { taskId, seed, score: 100, correct: 1, incorrect: 0, missed: 0, durationMs: 45_000, completedAt: "2026-08-13T00:00:00.000Z" };
    state = reduceBrainPetRuntime(state, { type: "session-finished", atMs: now++, result });
    state = reduceBrainPetRuntime(state, { type: "settled", atMs: now++ });
    state = reduceBrainPetRuntime(state, { type: "close-requested", atMs: now++ });
    state = reduceBrainPetRuntime(state, { type: "closed", atMs: now++ });
  }

  now += options.virtualDurationMs;
  return { cycles: options.cycles, virtualDurationMs: options.virtualDurationMs, moduleSwitches, crashesRecovered, finalPhase: state.phase as "idle", deterministicChecksum: checksum };
}
