import assert from "node:assert/strict";
import test from "node:test";

import { createBrainPetRuntimeSnapshot, createDeterministicRandom, pickBrainPetTask, reduceBrainPetRuntime } from "../src/brainpet/runtime-core.js";

test("runtime completes an open, play, settle, and close lifecycle", () => {
  let state = createBrainPetRuntimeSnapshot();
  state = reduceBrainPetRuntime(state, { type: "open-requested", atMs: 10 });
  state = reduceBrainPetRuntime(state, { type: "stage-ready", atMs: 20 });
  state = reduceBrainPetRuntime(state, { type: "session-started", atMs: 30, session: { taskId: "cargo-signal", seed: 42, durationMs: 45_000, level: 1 } });
  state = reduceBrainPetRuntime(state, { type: "pause-requested", atMs: 1_030 });
  state = reduceBrainPetRuntime(state, { type: "resume-requested", atMs: 2_030 });
  assert.equal(state.pausedDurationMs, 1_000);
  state = reduceBrainPetRuntime(state, { type: "session-finished", atMs: 45_030, result: { taskId: "cargo-signal", seed: 42, score: 800, correct: 8, incorrect: 1, missed: 1, durationMs: 45_000, completedAt: "2026-08-13T00:00:00.000Z" } });
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
  const running = reduceBrainPetRuntime(ready, { type: "session-started", atMs: 3, session: { taskId: "cargo-signal", seed: 5, durationMs: 45_000, level: 1 } });
  assert.throws(() => reduceBrainPetRuntime(running, { type: "session-finished", atMs: 4, result: { taskId: "pack-refresh", seed: 5, score: 0, correct: 0, incorrect: 0, missed: 0, durationMs: 1, completedAt: "x" } }), /does not match/);
});

test("seeded random and task selection are reproducible", () => {
  const a = createDeterministicRandom(1234);
  const b = createDeterministicRandom(1234);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.equal(pickBrainPetTask(99, ["cargo-signal", "pack-refresh"]), pickBrainPetTask(99, ["cargo-signal", "pack-refresh"]));
});
