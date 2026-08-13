import assert from "node:assert/strict";
import test from "node:test";

import { runBrainPetStageExercise } from "../src/brainpet/stage-exerciser.js";

test("stage exerciser survives 100 lifecycle cycles and module replacement", () => {
  const report = runBrainPetStageExercise({ cycles: 100, virtualDurationMs: 30 * 60 * 1_000, crashEvery: 10 });
  assert.equal(report.cycles, 100);
  assert.equal(report.virtualDurationMs, 1_800_000);
  assert.equal(report.moduleSwitches, 99);
  assert.equal(report.crashesRecovered, 10);
  assert.equal(report.finalPhase, "idle");
});

test("stage exerciser is deterministic for a fixed plan", () => {
  const a = runBrainPetStageExercise({ cycles: 100, virtualDurationMs: 1_800_000, crashEvery: 10 });
  const b = runBrainPetStageExercise({ cycles: 100, virtualDurationMs: 1_800_000, crashEvery: 10 });
  assert.equal(a.deterministicChecksum, b.deterministicChecksum);
});
