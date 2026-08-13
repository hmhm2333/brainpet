import assert from "node:assert/strict";
import test from "node:test";

import { createTaskModule } from "../src/renderer/src/brainpet/task-modules.js";

test("cargo signal task is deterministic and finishes at its declared duration", () => {
  const first = createTaskModule("cargo-signal");
  const second = createTaskModule("cargo-signal");
  first.start(20260813, 1, 0);
  second.start(20260813, 1, 0);
  assert.deepEqual(first.frame, second.frame);
  for (let now = 0; now <= first.manifest.durationMs; now += 100) {
    if (first.frame.tone === "sky") first.input({ type: "primary", atMs: now });
    if (second.frame.tone === "sky") second.input({ type: "primary", atMs: now });
    first.tick(now);
    second.tick(now);
  }
  assert.equal(first.finished, true);
  const { completedAt: _firstCompletedAt, ...firstResult } = first.result(first.manifest.durationMs);
  const { completedAt: _secondCompletedAt, ...secondResult } = second.result(second.manifest.durationMs);
  assert.deepEqual(firstResult, secondResult);
});

test("pack refresh task accepts both generic choice inputs through the same contract", () => {
  const task = createTaskModule("pack-refresh");
  task.start(99, 3, 0);
  assert.equal(task.frame.slots?.length, 3);
  const initialChoices = task.frame.choices;
  assert.equal(initialChoices, undefined);
  task.tick(1_800);
  const updatedChoices = task.frame.choices as readonly string[] | undefined;
  assert.equal(updatedChoices?.length, 2);
  task.input({ type: "secondary", atMs: 2_000 });
  task.tick(2_100);
  const result = task.result(2_100);
  assert.equal(result.correct + result.incorrect, 1);
  assert.equal(Number.isFinite(result.score), true);
});

test("stage exerciser is a replaceable task module, not a host special case", () => {
  const task = createTaskModule("stage-exerciser");
  task.start(1, 1, 0);
  task.input({ type: "primary", atMs: 100 });
  task.input({ type: "secondary", atMs: 200 });
  task.tick(45_000);
  assert.equal(task.finished, true);
  assert.equal(task.result(45_000).correct, 2);
});
