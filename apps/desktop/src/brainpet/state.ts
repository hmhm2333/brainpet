import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BrainPetTaskId, BrainPetTaskResult } from "./task-contract.js";
import { createTaskProgress, evaluateBrainPetResult, localDateKey, type BrainPetProgressionOutcome, type BrainPetTaskProgress, type PlayableBrainPetTaskId } from "./progression.js";
import { getBrainPetTaskManifest, isPlayableBrainPetTaskId, isRegisteredBrainPetTaskId, listPlayableBrainPetTaskIds } from "./task-registry.js";

export interface BrainPetPersistedState {
  readonly version: 2;
  readonly totalSessions: number;
  readonly highScores: Partial<Record<BrainPetTaskId, number>>;
  readonly recentResults: readonly BrainPetTaskResult[];
  readonly taskProgress: Readonly<Record<PlayableBrainPetTaskId, BrainPetTaskProgress>>;
  readonly recentTaskIds: readonly PlayableBrainPetTaskId[];
  readonly dailyCompletion: { readonly localDate: string; readonly count: number };
}

export interface BrainPetAppendResult {
  readonly state: BrainPetPersistedState;
  readonly outcome: BrainPetProgressionOutcome | null;
}

export function createBrainPetPersistedState(now = new Date()): BrainPetPersistedState {
  return {
    version: 2,
    totalSessions: 0,
    highScores: {},
    recentResults: [],
    taskProgress: Object.fromEntries(listPlayableBrainPetTaskIds().map((taskId) => [taskId, createTaskProgress(getBrainPetTaskManifest(taskId))])) as unknown as BrainPetPersistedState["taskProgress"],
    recentTaskIds: [],
    dailyCompletion: { localDate: localDateKey(now), count: 0 },
  };
}

export function loadBrainPetState(path: string, reportRecovery?: (message: string) => void): BrainPetPersistedState {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!isStateEnvelope(value)) throw new Error("BrainPet state schema is invalid.");
    return parseBrainPetState(value);
  } catch (error) {
    try {
      const backup = JSON.parse(readFileSync(`${path}.bak`, "utf8"));
      if (!isStateEnvelope(backup)) throw new Error("BrainPet backup schema is invalid.");
      reportRecovery?.(`Recovered BrainPet progress from backup after ${describeStateReadError(error)}.`);
      return parseBrainPetState(backup);
    } catch {
      if (!isMissingFileError(error)) reportRecovery?.(`BrainPet progress could not be read: ${describeStateReadError(error)}.`);
      return createBrainPetPersistedState();
    }
  }
}

export function appendBrainPetResult(state: BrainPetPersistedState, result: BrainPetTaskResult, now = new Date()): BrainPetAppendResult {
  const previousHigh = state.highScores[result.taskId] ?? 0;
  const dateKey = localDateKey(now);
  const dailyCompletion = state.dailyCompletion.localDate === dateKey ? state.dailyCompletion : { localDate: dateKey, count: 0 };
  if (!isPlayableBrainPetTaskId(result.taskId)) {
    return {
      state: { ...state, totalSessions: state.totalSessions + 1, highScores: { ...state.highScores, [result.taskId]: Math.max(previousHigh, result.score) }, recentResults: [result, ...state.recentResults].slice(0, 20), dailyCompletion },
      outcome: null,
    };
  }
  const manifest = getBrainPetTaskManifest(result.taskId);
  const storedProgress = state.taskProgress[result.taskId];
  const previousProgress = storedProgress?.parameterVersion === manifest.difficulty.parameterVersion ? storedProgress : createTaskProgress(manifest);
  const outcome = evaluateBrainPetResult(result, manifest, previousProgress);
  const storedResult: BrainPetTaskResult = { ...result, progression: { passed: outcome.passed, previousLevel: outcome.previousLevel, nextLevel: outcome.nextLevel, accuracy: outcome.accuracy } };
  const progress: BrainPetTaskProgress = {
    currentLevel: Math.max(previousProgress.currentLevel, outcome.nextLevel),
    clearedThroughLevel: outcome.passed ? Math.max(previousProgress.clearedThroughLevel, result.level) : previousProgress.clearedThroughLevel,
    highScoresByLevel: { ...previousProgress.highScoresByLevel, [String(result.level)]: Math.max(previousProgress.highScoresByLevel[String(result.level)] ?? 0, result.score) },
    parameterVersion: manifest.difficulty.parameterVersion,
  };
  return {
    state: {
      version: 2,
      totalSessions: state.totalSessions + 1,
      highScores: { ...state.highScores, [result.taskId]: Math.max(previousHigh, result.score) },
      recentResults: [storedResult, ...state.recentResults].slice(0, 20),
      taskProgress: { ...state.taskProgress, [result.taskId]: progress },
      recentTaskIds: [result.taskId, ...state.recentTaskIds].slice(0, 2),
      dailyCompletion: { localDate: dateKey, count: dailyCompletion.count + 1 },
    },
    outcome,
  };
}

export async function saveBrainPetState(path: string, state: BrainPetPersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    try {
      const existing = JSON.parse(await readFile(path, "utf8"));
      if (isStateEnvelope(existing)) await copyFile(path, `${path}.bak`);
    } catch {
      // A missing or malformed primary file must not overwrite a valid backup.
    }
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function parseBrainPetState(value: unknown): BrainPetPersistedState {
  const fallback = createBrainPetPersistedState();
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Number.isInteger(value.totalSessions) || (value.totalSessions as number) < 0) return fallback;
  const highScores: Partial<Record<BrainPetTaskId, number>> = {};
  if (isRecord(value.highScores)) {
    for (const [taskId, score] of Object.entries(value.highScores)) {
      if (isRegisteredBrainPetTaskId(taskId) && typeof score === "number" && Number.isFinite(score) && score >= 0) highScores[taskId] = Math.round(score);
    }
  }
  const recentResults = Array.isArray(value.recentResults) ? value.recentResults.filter(isPersistedResult).slice(0, 20) : [];
  if (value.version === 1) return { ...fallback, totalSessions: value.totalSessions as number, highScores, recentResults, recentTaskIds: recentResults.map((result) => result.taskId).filter(isPlayableBrainPetTaskId).slice(0, 2) };
  const taskProgress = { ...fallback.taskProgress };
  if (isRecord(value.taskProgress)) {
    for (const taskId of listPlayableBrainPetTaskIds()) {
      const parsed = parseTaskProgress(value.taskProgress[taskId], getBrainPetTaskManifest(taskId));
      if (parsed) taskProgress[taskId] = parsed;
    }
  }
  const recentTaskIds = Array.isArray(value.recentTaskIds) ? value.recentTaskIds.filter(isPlayableBrainPetTaskId).slice(0, 2) : [];
  const dailyCompletion = isRecord(value.dailyCompletion) && typeof value.dailyCompletion.localDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.dailyCompletion.localDate) && Number.isInteger(value.dailyCompletion.count) && (value.dailyCompletion.count as number) >= 0
    ? { localDate: value.dailyCompletion.localDate, count: value.dailyCompletion.count as number }
    : fallback.dailyCompletion;
  return { version: 2, totalSessions: value.totalSessions as number, highScores, recentResults, taskProgress, recentTaskIds, dailyCompletion };
}

function parseTaskProgress(value: unknown, manifest: ReturnType<typeof getBrainPetTaskManifest>): BrainPetTaskProgress | null {
  if (!isRecord(value) || !Number.isInteger(value.currentLevel) || !Number.isInteger(value.clearedThroughLevel) || !isRecord(value.highScoresByLevel) || typeof value.parameterVersion !== "string") return null;
  if (value.parameterVersion !== manifest.difficulty.parameterVersion) return createTaskProgress(manifest);
  const currentLevel = Math.max(1, Math.min(manifest.difficulty.maxLevel, value.currentLevel as number));
  const highScoresByLevel: Record<string, number> = {};
  for (const [level, score] of Object.entries(value.highScoresByLevel)) if (/^\d+$/.test(level) && typeof score === "number" && Number.isFinite(score) && score >= 0) highScoresByLevel[level] = Math.round(score);
  return { currentLevel, clearedThroughLevel: Math.max(0, Math.min(manifest.difficulty.maxLevel, value.clearedThroughLevel as number)), highScoresByLevel, parameterVersion: manifest.difficulty.parameterVersion };
}

function isPersistedResult(value: unknown): value is BrainPetTaskResult {
  return isRecord(value)
    && isRegisteredBrainPetTaskId(value.taskId)
    && Number.isInteger(value.seed)
    && typeof value.score === "number" && Number.isFinite(value.score)
    && Number.isInteger(value.correct)
    && Number.isInteger(value.incorrect)
    && Number.isInteger(value.missed)
    && Number.isInteger(value.durationMs)
    && typeof value.startedAt === "string" && value.startedAt.length <= 64
    && typeof value.completedAt === "string" && value.completedAt.length <= 64
    && value.completionStatus === "completed"
    && typeof value.taskVersion === "string"
    && typeof value.assetVersion === "string"
    && value.difficultyPolicyVersion === "brainpet-block-v1"
    && (value.scoreVersion === "brainpet-score-v1" || value.scoreVersion === "brainpet-score-v2")
    && Number.isInteger(value.level)
    && Number.isInteger(value.falseAlarms)
    && (value.meanReactionTimeMs === null || Number.isFinite(value.meanReactionTimeMs))
    && Array.isArray(value.trials)
    && isRecord(value.quality)
    && typeof value.quality.valid === "boolean"
    && Array.isArray(value.petEvents);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStateEnvelope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (value.version === 1 || value.version === 2) && Number.isInteger(value.totalSessions) && (value.totalSessions as number) >= 0;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function describeStateReadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
