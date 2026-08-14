import assert from "node:assert/strict";
import test from "node:test";

import { matchesIssuedBrainPetSession } from "../src/brainpet/session-ownership.js";
import { canonicalizeBrainPetTaskResult, type BrainPetTaskResult } from "../src/brainpet/task-contract.js";
import { getBrainPetDifficultyParameters, getBrainPetTaskDefinition } from "../src/brainpet/task-registry.js";

const definition = getBrainPetTaskDefinition("cargo-signal");
const session = { taskId: "cargo-signal", seed: 7, durationMs: definition.manifest.durationMs, level: 1, difficultyPolicyVersion: definition.manifest.difficulty.policyVersion, parameterVersion: definition.manifest.difficulty.parameterVersion, parameters: getBrainPetDifficultyParameters("cargo-signal", 1), blockCount: definition.manifest.difficulty.blockCount };

test("only the exact Host-issued session can start", () => {
  assert.equal(matchesIssuedBrainPetSession(session, { ...session }), true);
  assert.equal(matchesIssuedBrainPetSession(session, { ...session, seed: 8 }), false);
  assert.equal(matchesIssuedBrainPetSession(session, { ...session, level: 2 }), false);
  assert.equal(matchesIssuedBrainPetSession(session, { ...session, parameters: { ...session.parameters, responseWindowMs: 1 } }), false);
});

test("Host evaluator ignores renderer-authored correctness and aggregates", () => {
  const candidate: BrainPetTaskResult = {
    ...session,
    score: 9_999,
    correct: 99,
    incorrect: 0,
    missed: 0,
    startedAt: "2026-08-14T00:00:00.000Z",
    completedAt: "2026-08-14T00:00:45.000Z",
    completionStatus: "completed",
    taskVersion: definition.manifest.taskVersion,
    assetVersion: definition.manifest.assetVersion,
    scoreVersion: definition.manifest.scoring.version,
    falseAlarms: 0,
    meanReactionTimeMs: 10,
    trials: [{ stimulusId: "go-1", stimulusKind: "go", blockIndex: 1, plannedAtMs: 0, presentedAtMs: 0, inputType: "none", inputAtMs: null, correct: true, reactionTimeMs: null }],
    quality: { valid: true, focusLossCount: 0, pausedMs: 0, droppedFrameCount: 0, longFrameCount: 0, maxFrameMs: 16, flags: [] },
    petEvents: ["new-best"],
  };
  const result = canonicalizeBrainPetTaskResult(definition.manifest, candidate, definition.expectedInputForTrial);
  assert.ok(result);
  assert.equal(result.correct, 0);
  assert.equal(result.missed, 1);
  assert.equal(result.score, 0);
  assert.deepEqual(result.petEvents, ["complete"]);
  assert.equal(result.trials[0]?.correct, false);
});

test("Host evaluator derives reaction time from event timestamps", () => {
  const candidate: BrainPetTaskResult = {
    ...session,
    score: 9_999,
    correct: 1,
    incorrect: 0,
    missed: 0,
    startedAt: "2026-08-14T00:00:00.000Z",
    completedAt: "2026-08-14T00:00:45.000Z",
    completionStatus: "completed",
    taskVersion: definition.manifest.taskVersion,
    assetVersion: definition.manifest.assetVersion,
    scoreVersion: definition.manifest.scoring.version,
    falseAlarms: 0,
    meanReactionTimeMs: 1,
    trials: [{ stimulusId: "go-1", stimulusKind: "go", blockIndex: 1, plannedAtMs: 0, presentedAtMs: 100, inputType: "primary", inputAtMs: 600, correct: true, reactionTimeMs: 1 }],
    quality: { valid: true, focusLossCount: 0, pausedMs: 0, droppedFrameCount: 0, longFrameCount: 0, maxFrameMs: 16, flags: [] },
    petEvents: ["complete"],
  };
  const result = canonicalizeBrainPetTaskResult(definition.manifest, candidate, definition.expectedInputForTrial);
  assert.equal(result?.trials[0]?.reactionTimeMs, 500);
  assert.equal(result?.meanReactionTimeMs, 500);
});
