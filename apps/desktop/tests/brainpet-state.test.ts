import assert from "node:assert/strict";
import test from "node:test";

import { appendBrainPetResult, createBrainPetPersistedState, parseBrainPetState } from "../src/brainpet/state.js";

const result = { taskId: "cargo-signal", seed: 7, score: 720, correct: 8, incorrect: 1, missed: 0, durationMs: 45_000, startedAt: "2026-08-13T00:00:00.000Z", completedAt: "2026-08-13T00:00:45.000Z", completionStatus: "completed", taskVersion: "1.1.0", assetVersion: "1.0.0", difficultyPolicyVersion: "brainpet-block-v1", parameterVersion: "1.0.0", parameters: { responseWindowMs: 1050, blockStepMs: 70, goProbabilityPercent: 72, similarityTier: 1 }, blockCount: 3, scoreVersion: "brainpet-score-v1", level: 1, falseAlarms: 0, meanReactionTimeMs: 350, trials: [], quality: { valid: true, focusLossCount: 0, pausedMs: 0, droppedFrameCount: 0, longFrameCount: 0, maxFrameMs: 16.7, flags: [] }, petEvents: ["complete"] } as const;

test("BrainPet state records bounded recent results and high scores", () => {
  let state = createBrainPetPersistedState();
  for (let index = 0; index < 25; index += 1) state = appendBrainPetResult(state, { ...result, score: index }).state;
  assert.equal(state.totalSessions, 25);
  assert.equal(state.recentResults.length, 20);
  assert.equal(state.highScores["cargo-signal"], 24);
});

test("BrainPet state parser discards malformed data", () => {
  assert.deepEqual(parseBrainPetState({ version: 99 }), createBrainPetPersistedState());
  const parsed = parseBrainPetState({ version: 1, totalSessions: 2, highScores: { "cargo-signal": 200, evil: 900 }, recentResults: [result, { taskId: "evil" }] });
  assert.deepEqual(parsed.highScores, { "cargo-signal": 200 });
  assert.equal(parsed.recentResults.length, 1);
  assert.equal(parsed.version, 2);
});

test("BrainPet progression advances a passed level and records daily completion", () => {
  const trials = Array.from({ length: 8 }, (_, index) => ({ stimulusId: `trial-${index}`, stimulusKind: "go", blockIndex: Math.min(3, Math.floor(index / 3) + 1) as 1 | 2 | 3, plannedAtMs: index * 1000, presentedAtMs: index * 1000, inputType: "primary" as const, inputAtMs: index * 1000 + 300, correct: index < 7, reactionTimeMs: 300 }));
  const complete = { ...result, correct: 7, incorrect: 1, trials, score: 660 };
  const appended = appendBrainPetResult(createBrainPetPersistedState(new Date(2026, 7, 13)), complete, new Date(2026, 7, 13));
  assert.equal(appended.outcome?.passed, true);
  assert.equal(appended.state.taskProgress["cargo-signal"].currentLevel, 2);
  assert.equal(appended.state.taskProgress["cargo-signal"].highScoresByLevel["1"], 660);
  assert.equal(appended.state.dailyCompletion.count, 1);
});
