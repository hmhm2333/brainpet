import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendBrainPetResult, createBrainPetPersistedState, loadBrainPetState, parseBrainPetState, saveBrainPetState } from "../src/brainpet/state.js";
import { getBrainPetDifficultyParameters, getBrainPetTaskManifest } from "../src/brainpet/task-registry.js";

const manifest = getBrainPetTaskManifest("cargo-signal");
const result = { taskId: "cargo-signal", seed: 7, score: 720, correct: 8, incorrect: 1, missed: 0, durationMs: manifest.durationMs, startedAt: "2026-08-13T00:00:00.000Z", completedAt: "2026-08-13T00:00:45.000Z", completionStatus: "completed", taskVersion: manifest.taskVersion, assetVersion: manifest.assetVersion, difficultyPolicyVersion: manifest.difficulty.policyVersion, parameterVersion: manifest.difficulty.parameterVersion, parameters: getBrainPetDifficultyParameters("cargo-signal", 1), blockCount: manifest.difficulty.blockCount, scoreVersion: manifest.scoring.version, level: 1, falseAlarms: 0, meanReactionTimeMs: 350, trials: [], quality: { valid: true, focusLossCount: 0, pausedMs: 0, droppedFrameCount: 0, longFrameCount: 0, maxFrameMs: 16.7, flags: [] }, petEvents: ["complete"] } as const;

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
  const trials = Array.from({ length: 24 }, (_, index) => {
    const noGo = index >= 18;
    const correct = index !== 17 && index !== 23;
    return { stimulusId: `trial-${index}`, stimulusKind: noGo ? "no-go" : "go", blockIndex: Math.min(3, Math.floor(index / 8) + 1) as 1 | 2 | 3, plannedAtMs: index * 1000, presentedAtMs: index * 1000, inputType: correct ? (noGo ? "none" as const : "primary" as const) : (noGo ? "primary" as const : "none" as const), inputAtMs: correct && !noGo || !correct && noGo ? index * 1000 + 300 : null, correct, reactionTimeMs: correct && !noGo ? 300 : null };
  });
  const complete = { ...result, correct: 22, incorrect: 1, missed: 1, falseAlarms: 1, trials, score: 2_200 };
  const appended = appendBrainPetResult(createBrainPetPersistedState(new Date(2026, 7, 13)), complete, new Date(2026, 7, 13));
  assert.equal(appended.outcome?.passed, true);
  assert.equal(appended.state.taskProgress["cargo-signal"].currentLevel, 2);
  assert.equal(appended.state.taskProgress["cargo-signal"].highScoresByLevel["1"], 2_200);
  assert.equal(appended.state.dailyCompletion.count, 1);
});

test("a parameter version change resets incomparable per-level progression", () => {
  const stale = {
    ...createBrainPetPersistedState(new Date(2026, 7, 13)),
    taskProgress: {
      ...createBrainPetPersistedState(new Date(2026, 7, 13)).taskProgress,
      "cargo-signal": { currentLevel: 7, clearedThroughLevel: 6, highScoresByLevel: { "6": 9999 }, parameterVersion: "1.0.0" },
    },
  };
  const parsed = parseBrainPetState(stale);
  assert.equal(parsed.taskProgress["cargo-signal"].currentLevel, 1);
  assert.equal(parsed.taskProgress["cargo-signal"].clearedThroughLevel, 0);
  assert.deepEqual(parsed.taskProgress["cargo-signal"].highScoresByLevel, {});
  assert.equal(parsed.taskProgress["cargo-signal"].parameterVersion, "2.2.0");
});

test("state loading recovers the last known good file without overwriting it with corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brainpet-state-"));
  const path = join(directory, "brainpet-state.json");
  try {
    const initial = { ...createBrainPetPersistedState(), totalSessions: 3 };
    await saveBrainPetState(path, initial);
    await saveBrainPetState(path, { ...initial, totalSessions: 4 });
    await writeFile(path, "{broken", "utf8");
    const messages: string[] = [];
    const recovered = loadBrainPetState(path, (message) => messages.push(message));
    assert.equal(recovered.totalSessions, 3);
    assert.equal(messages.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
