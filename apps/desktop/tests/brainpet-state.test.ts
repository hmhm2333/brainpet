import assert from "node:assert/strict";
import test from "node:test";

import { appendBrainPetResult, createBrainPetPersistedState, parseBrainPetState } from "../src/brainpet/state.js";

const result = { taskId: "cargo-signal", seed: 7, score: 720, correct: 8, incorrect: 1, missed: 0, durationMs: 45_000, completedAt: "2026-08-13T00:00:00.000Z", taskVersion: "1.0.0", assetVersion: "1.0.0", difficultyPolicyVersion: "brainpet-block-v1", scoreVersion: "brainpet-score-v1", level: 1, falseAlarms: 0, meanReactionTimeMs: 350, trials: [], quality: { valid: true, focusLossCount: 0, pausedMs: 0, droppedFrameCount: 0, longFrameCount: 0, maxFrameMs: 16.7, flags: [] }, petEvents: ["complete"] } as const;

test("BrainPet state records bounded recent results and high scores", () => {
  let state = createBrainPetPersistedState();
  for (let index = 0; index < 25; index += 1) state = appendBrainPetResult(state, { ...result, score: index });
  assert.equal(state.totalSessions, 25);
  assert.equal(state.recentResults.length, 20);
  assert.equal(state.highScores["cargo-signal"], 24);
});

test("BrainPet state parser discards malformed data", () => {
  assert.deepEqual(parseBrainPetState({ version: 99 }), createBrainPetPersistedState());
  const parsed = parseBrainPetState({ version: 1, totalSessions: 2, highScores: { "cargo-signal": 200, evil: 900 }, recentResults: [result, { taskId: "evil" }] });
  assert.deepEqual(parsed.highScores, { "cargo-signal": 200 });
  assert.equal(parsed.recentResults.length, 1);
});
