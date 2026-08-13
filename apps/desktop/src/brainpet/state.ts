import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isTaskId, type BrainPetTaskId, type BrainPetTaskResult } from "./task-contract.js";

export interface BrainPetPersistedState {
  readonly version: 1;
  readonly totalSessions: number;
  readonly highScores: Partial<Record<BrainPetTaskId, number>>;
  readonly recentResults: readonly BrainPetTaskResult[];
}

export function createBrainPetPersistedState(): BrainPetPersistedState {
  return { version: 1, totalSessions: 0, highScores: {}, recentResults: [] };
}

export function loadBrainPetState(path: string): BrainPetPersistedState {
  try {
    return parseBrainPetState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return createBrainPetPersistedState();
  }
}

export function appendBrainPetResult(state: BrainPetPersistedState, result: BrainPetTaskResult): BrainPetPersistedState {
  const previousHigh = state.highScores[result.taskId] ?? 0;
  return {
    version: 1,
    totalSessions: state.totalSessions + 1,
    highScores: { ...state.highScores, [result.taskId]: Math.max(previousHigh, result.score) },
    recentResults: [result, ...state.recentResults].slice(0, 20),
  };
}

export async function saveBrainPetState(path: string, state: BrainPetPersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

export function parseBrainPetState(value: unknown): BrainPetPersistedState {
  if (!isRecord(value) || value.version !== 1 || !Number.isInteger(value.totalSessions) || (value.totalSessions as number) < 0) return createBrainPetPersistedState();
  const highScores: Partial<Record<BrainPetTaskId, number>> = {};
  if (isRecord(value.highScores)) {
    for (const [taskId, score] of Object.entries(value.highScores)) {
      if (isTaskId(taskId) && typeof score === "number" && Number.isFinite(score) && score >= 0) highScores[taskId] = Math.round(score);
    }
  }
  const recentResults = Array.isArray(value.recentResults) ? value.recentResults.filter(isPersistedResult).slice(0, 20) : [];
  return { version: 1, totalSessions: value.totalSessions as number, highScores, recentResults };
}

function isPersistedResult(value: unknown): value is BrainPetTaskResult {
  return isRecord(value)
    && isTaskId(value.taskId)
    && Number.isInteger(value.seed)
    && typeof value.score === "number" && Number.isFinite(value.score)
    && Number.isInteger(value.correct)
    && Number.isInteger(value.incorrect)
    && Number.isInteger(value.missed)
    && Number.isInteger(value.durationMs)
    && typeof value.completedAt === "string" && value.completedAt.length <= 64;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
