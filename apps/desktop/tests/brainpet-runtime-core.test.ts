import assert from "node:assert/strict";
import test from "node:test";

import { createBrainPetRuntimeSnapshot, createDeterministicRandom, pickBrainPetTask, reduceBrainPetRuntime } from "../src/brainpet/runtime-core.js";

test("runtime completes an open, play, settle, and close lifecycle", () => {
  let state = createBrainPetRuntimeSnapshot();
  state = reduceBrainPetRuntime(state, { type: "open-requested", atMs: 10 });
  state = reduceBrainPetRuntime(state, { type: "stage-ready", atMs: 20 });
  state = reduceBrainPetRuntime(state, { type: "session-started", atMs: 30, session: session(42) });
  state = reduceBrainPetRuntime(state, { type: "pause-requested", atMs: 1_030 });
  state = reduceBrainPetRuntime(state, { type: "resume-requested", atMs: 2_030 });
  assert.equal(state.pausedDurationMs, 1_000);
  state = reduceBrainPetRuntime(state, { type: "session-finished", atMs: 45_030, result: resultFixture("cargo-signal", 42, 800) });
  state = reduceBrainPetRuntime(state, { type: "settled", atMs: 46_000 });
  state = reduceBrainPetRuntime(state, { type: "close-requested", atMs: 47_000 });
  state = reduceBrainPetRuntime(state, { type: "closed", atMs: 47_100 });
  assert.equal(state.phase, "idle");
  assert.equal(state.lastResult?.score, 800);
});

test("runtime rejects illegal transitions and mismatched results", () => {
  const idle = createBrainPetRuntimeSnapshot();
  assert.throws(() => reduceBrainPetRuntime(idle, { type: "stage-ready", atMs: 1 }), /Invalid BrainPet runtime transition/);
  const ready = reduceBrainPetRuntime(reduceBrainPetRuntime(idle, { type: "open-requested", atMs: 1 }), { type: "stage-ready", atMs: 2 });
  const running = reduceBrainPetRuntime(ready, { type: "session-started", atMs: 3, session: session(5) });
  assert.throws(() => reduceBrainPetRuntime(running, { type: "session-finished", atMs: 4, result: resultFixture("pack-refresh", 5, 0) }), /does not match/);
});

function resultFixture(taskId: "cargo-signal" | "pack-refresh", seed: number, score: number) {
  return { taskId, seed, score, correct: 8, incorrect: 1, missed: 1, durationMs: 45_000, startedAt: "2026-08-13T00:00:00.000Z", completedAt: "2026-08-13T00:00:45.000Z", completionStatus: "completed" as const, taskVersion: "1.1.0", assetVersion: "1.0.0", difficultyPolicyVersion: "brainpet-block-v1", parameterVersion: "1.0.0", parameters: { responseWindowMs: 1050, blockStepMs: 70, goProbabilityPercent: 72, similarityTier: 1 }, blockCount: 3 as const, scoreVersion: "brainpet-score-v1", level: 1, falseAlarms: 0, meanReactionTimeMs: 350, trials: [], quality: { valid: true, focusLossCount: 0, pausedMs: 0, droppedFrameCount: 0, longFrameCount: 0, maxFrameMs: 16.7, flags: [] }, petEvents: ["complete" as const] };
}

function session(seed: number) {
  return { taskId: "cargo-signal" as const, seed, durationMs: 45_000, level: 1, difficultyPolicyVersion: "brainpet-block-v1", parameterVersion: "1.0.0", parameters: { responseWindowMs: 1050, blockStepMs: 70, goProbabilityPercent: 72, similarityTier: 1 }, blockCount: 3 as const };
}

test("seeded random and task selection are reproducible", () => {
  const a = createDeterministicRandom(1234);
  const b = createDeterministicRandom(1234);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.equal(pickBrainPetTask(99, ["cargo-signal", "pack-refresh"]), pickBrainPetTask(99, ["cargo-signal", "pack-refresh"]));
});
