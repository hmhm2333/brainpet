import assert from "node:assert/strict";
import test from "node:test";

import { computeDeclaredScore, validateBrainPetTaskManifest } from "../src/brainpet/task-contract.js";
import { getBrainPetTaskManifest, listPlayableBrainPetTaskIds } from "../src/brainpet/task-registry.js";

test("task contract accepts a deterministic bounded task", () => {
  const manifest = validateBrainPetTaskManifest({ apiVersion: 1, id: "cargo-signal", title: "装箱，还是放过", durationMs: 45_000, supportsSeed: true, taskVersion: "1.0.0", assetVersion: "1.0.0", scoring: { version: "brainpet-score-v1", correctPoints: 100, incorrectPoints: -40 } });
  assert.equal(manifest.id, "cargo-signal");
  assert.equal(computeDeclaredScore(manifest, [
    { stimulusId: "1", stimulusKind: "go", plannedAtMs: 0, presentedAtMs: 1, inputType: "primary", inputAtMs: 201, correct: true, reactionTimeMs: 200 },
    { stimulusId: "2", stimulusKind: "no-go", plannedAtMs: 500, presentedAtMs: 501, inputType: "primary", inputAtMs: 650, correct: false, reactionTimeMs: 149 },
  ]), 60);
});

test("task registry is the only task-specific manifest boundary", () => {
  assert.deepEqual(listPlayableBrainPetTaskIds(), ["cargo-signal", "pack-refresh"]);
  for (const taskId of ["stage-exerciser", ...listPlayableBrainPetTaskIds()] as const) {
    assert.equal(validateBrainPetTaskManifest(getBrainPetTaskManifest(taskId)).id, taskId);
  }
});

test("task contract rejects unsupported, long, and unseeded tasks", () => {
  assert.throws(() => validateBrainPetTaskManifest({ apiVersion: 2, id: "cargo-signal", title: "x", durationMs: 45_000, supportsSeed: true }), /version/);
  assert.throws(() => validateBrainPetTaskManifest({ apiVersion: 1, id: "cargo-signal", title: "x", durationMs: 5_000, supportsSeed: true }), /duration/);
  assert.throws(() => validateBrainPetTaskManifest({ apiVersion: 1, id: "cargo-signal", title: "x", durationMs: 45_000, supportsSeed: false }), /deterministic/);
});
