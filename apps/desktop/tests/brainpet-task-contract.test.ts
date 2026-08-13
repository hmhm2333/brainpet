import assert from "node:assert/strict";
import test from "node:test";

import { validateBrainPetTaskManifest } from "../src/brainpet/task-contract.js";

test("task contract accepts a deterministic bounded task", () => {
  const manifest = validateBrainPetTaskManifest({ apiVersion: 1, id: "cargo-signal", title: "装箱，还是放过", durationMs: 45_000, supportsSeed: true });
  assert.equal(manifest.id, "cargo-signal");
});

test("task contract rejects unsupported, long, and unseeded tasks", () => {
  assert.throws(() => validateBrainPetTaskManifest({ apiVersion: 2, id: "cargo-signal", title: "x", durationMs: 45_000, supportsSeed: true }), /version/);
  assert.throws(() => validateBrainPetTaskManifest({ apiVersion: 1, id: "cargo-signal", title: "x", durationMs: 5_000, supportsSeed: true }), /duration/);
  assert.throws(() => validateBrainPetTaskManifest({ apiVersion: 1, id: "cargo-signal", title: "x", durationMs: 45_000, supportsSeed: false }), /deterministic/);
});
