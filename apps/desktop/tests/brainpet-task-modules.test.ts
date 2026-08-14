import assert from "node:assert/strict";
import test from "node:test";

import { createTaskModule } from "../src/renderer/src/brainpet/task-modules.js";
import { createCargoSignalTrialPlan, getBrainPetDifficultyParameters } from "../src/brainpet/task-registry.js";
import { computeBrainPetTrialScore } from "../src/brainpet/task-contract.js";

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
  const { completedAt: _firstCompletedAt, startedAt: _firstStartedAt, ...firstResult } = first.result(first.manifest.durationMs);
  const { completedAt: _secondCompletedAt, startedAt: _secondStartedAt, ...secondResult } = second.result(second.manifest.durationMs);
  assert.deepEqual(firstResult, secondResult);
  assert.deepEqual([...new Set(firstResult.trials.map((trial) => trial.blockIndex))], [1, 2, 3]);
  assert.equal(firstResult.parameterVersion, "2.2.0");
  assert.equal(firstResult.blockCount, 3);
  assert.equal(Number.isInteger(first.result(44_999.75).durationMs), true);
  assert.equal(firstResult.trials.length, 24);
  assert.equal(firstResult.trials.filter((trial) => trial.stimulusKind === "go").length, 18);
  assert.equal(firstResult.trials.filter((trial) => trial.stimulusKind === "no-go").length, 6);
});

test("cargo signal starts reaction timing and accepts input when the pet releases the object", () => {
  const task = createTaskModule("cargo-signal");
  task.start(2, 1, 0);
  assert.deepEqual(task.manifest.assets?.map((asset) => asset.id), ["cargo-go", "cargo-no-go", "cargo-go-capsule", "cargo-no-go-capsule", "cargo-go-orb", "cargo-no-go-orb", "cargo-dock"]);
  assert.equal(task.frame.scene?.id, "cargo-toss");
  assert.equal(task.frame.scene?.reactionInput, "primary");
  assert.equal(task.frame.scene?.rigProjectiles?.[0]?.input, undefined);
  assert.equal(task.frame.scene?.layers[0]?.sprites[0]?.input, undefined);
  task.input({ type: "primary", atMs: 120 });
  assert.equal(task.frame.scene?.rigProjectiles?.length, 0);
  const result = task.result(120);
  const accepted = result.trials[0]!;
  assert.equal(accepted.presentedAtMs, 0);
  assert.equal(accepted.reactionTimeMs, 120);
  assert.equal(task.frame.feedbackScore, computeBrainPetTrialScore(task.manifest, accepted, result.parameters));
});

test("cargo signal plan is seeded, exact, and run constrained", () => {
  const parameters = getBrainPetDifficultyParameters("cargo-signal", 1);
  const plan = createCargoSignalTrialPlan(42, parameters);
  assert.deepEqual(plan, createCargoSignalTrialPlan(42, parameters));
  assert.equal(plan.length, 24);
  assert.equal(plan[0]?.kind, "go");
  assert.equal(plan.filter((trial) => trial.kind === "go").length, 18);
  assert.equal(plan.filter((trial) => trial.kind === "no-go").length, 6);
  assert.equal(plan.every((trial) => trial.flightMs === parameters.responseWindowMs), true);
  assert.equal(new Set(plan.map((trial) => trial.cargoVariant)).size > 1, true);
  assert.equal(new Set(plan.map((trial) => trial.curveOffsetPx)).size > 1, true);
  assert.equal(plan.every((trial) => trial.spinTurns === -1 || trial.spinTurns === 1), true);
  const runs = plan.reduce<Array<{ kind: "go" | "no-go"; count: number }>>((items, trial) => {
    const last = items.at(-1);
    if (last?.kind === trial.kind) last.count += 1;
    else items.push({ kind: trial.kind, count: 1 });
    return items;
  }, []);
  assert.equal(runs.every((run) => run.count <= (run.kind === "go" ? 4 : 2)), true);
});

test("cargo signal moves the object along a deterministic arc toward the dock", () => {
  const first = createTaskModule("cargo-signal");
  const second = createTaskModule("cargo-signal");
  first.start(13, 1, 0);
  second.start(13, 1, 0);
  const start = first.frame.scene?.rigProjectiles?.[0];
  first.tick(320);
  second.tick(320);
  const moved = first.frame.scene?.rigProjectiles?.[0];
  assert.ok(start && moved);
  assert.equal(moved.progress > start.progress, true);
  assert.deepEqual(first.frame.scene, second.frame.scene);
});

test("cargo signal restarts an unanswered active trial after layout movement", () => {
  const task = createTaskModule("cargo-signal");
  task.start(13, 1, 0);
  task.tick(320);
  const before = task.frame.scene?.rigProjectiles?.[0];
  assert.ok(before && before.progress > 0);
  assert.equal(task.restartActiveTrial(320), true);
  const restarted = task.frame.scene?.rigProjectiles?.[0];
  assert.ok(restarted);
  assert.equal(restarted.progress, 0);
  assert.notEqual(restarted.id, before.id);
  assert.equal(task.result(320).trials.length, 0);
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

test("pack refresh level changes capacity while each block changes only response time", () => {
  const task = createTaskModule("pack-refresh");
  task.start(99, 4, 0);
  assert.equal(task.frame.slots?.length, 4);
  assert.equal(task.result(0).parameters.capacity, 4);
  assert.deepEqual(Object.keys(task.result(0).parameters).sort(), ["blockStepMs", "capacity", "responseWindowMs"]);
});

test("pack refresh candidates cannot be solved from the currently visible set", () => {
  const task = createTaskModule("pack-refresh");
  task.start(19, 5, 0);
  let previousSlots = [...task.frame.slots!];
  let nowMs = 1_800;
  for (let round = 0; round < 8; round += 1) {
    task.tick(nowMs);
    const currentSlots = [...task.frame.slots!];
    const choices = [...task.frame.choices!];
    assert.equal(choices.length, 2);
    assert.equal(choices.every((choice) => !currentSlots.includes(choice)), true, "both candidates must be absent from the updated set");
    const priorMembers = choices.filter((choice) => previousSlots.includes(choice));
    assert.equal(priorMembers.length, 1, "only the removed item may belong to the previous set");
    const correctIndex = choices.indexOf(priorMembers[0]!);
    task.input({ type: correctIndex === 0 ? "primary" : "secondary", atMs: nowMs + 200 });
    previousSlots = currentSlots;
    nowMs += 4_000;
  }
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

test("an heterogeneous foundation module uses the generic scene, asset and input contracts", () => {
  const task = createTaskModule("foundation-probe");
  task.start(11, 1, 0);
  assert.equal(task.manifest.assets?.[0]?.id, "probe-gem");
  assert.equal(task.frame.scene?.layers.length, 2);
  assert.deepEqual(task.frame.scene?.layers[1]?.sprites.map((sprite) => sprite.input), ["primary", "secondary"]);
  task.input({ type: "primary", atMs: 100 });
  assert.equal(task.result(100).trials[0]?.stimulusKind, "probe-left");
});
