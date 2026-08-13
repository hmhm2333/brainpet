import assert from "node:assert/strict";
import test from "node:test";

import { chooseBrainPetTask, localDateKey } from "../src/brainpet/progression.js";

test("task selection prevents a third consecutive task when another is available", () => {
  assert.equal(chooseBrainPetTask(["cargo-signal", "pack-refresh"], 2, ["cargo-signal", "cargo-signal"]), "pack-refresh");
  assert.equal(chooseBrainPetTask(["cargo-signal"], 2, ["cargo-signal", "cargo-signal"]), "cargo-signal");
});

test("task selection remains deterministic for the same seed and history", () => {
  assert.equal(chooseBrainPetTask(["cargo-signal", "pack-refresh"], 9, []), "pack-refresh");
  assert.equal(chooseBrainPetTask(["cargo-signal", "pack-refresh"], 9, []), "pack-refresh");
  assert.equal(localDateKey(new Date(2026, 7, 3, 23, 30)), "2026-08-03");
});
