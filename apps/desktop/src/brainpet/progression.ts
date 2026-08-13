import type { BrainPetTaskId, BrainPetTaskManifest, BrainPetTaskResult } from "./task-contract.js";

export type PlayableBrainPetTaskId = Exclude<BrainPetTaskId, "stage-exerciser">;

export interface BrainPetTaskProgress {
  readonly currentLevel: number;
  readonly clearedThroughLevel: number;
  readonly highScoresByLevel: Readonly<Record<string, number>>;
  readonly parameterVersion: string;
}

export interface BrainPetProgressionOutcome {
  readonly passed: boolean;
  readonly previousLevel: number;
  readonly nextLevel: number;
  readonly accuracy: number;
  readonly isNewLevelBest: boolean;
}

export function createTaskProgress(manifest: BrainPetTaskManifest): BrainPetTaskProgress {
  return { currentLevel: 1, clearedThroughLevel: 0, highScoresByLevel: {}, parameterVersion: manifest.difficulty.parameterVersion };
}

export function evaluateBrainPetResult(result: BrainPetTaskResult, manifest: BrainPetTaskManifest, progress: BrainPetTaskProgress): BrainPetProgressionOutcome {
  const decisions = result.correct + result.incorrect + result.missed;
  const accuracy = decisions === 0 ? 0 : result.correct / decisions;
  const passed = result.quality.valid
    && result.correct >= manifest.difficulty.minimumCorrect
    && accuracy >= manifest.difficulty.passAccuracy;
  const previousBest = progress.highScoresByLevel[String(result.level)] ?? 0;
  return {
    passed,
    previousLevel: result.level,
    nextLevel: passed ? Math.min(manifest.difficulty.maxLevel, result.level + 1) : result.level,
    accuracy,
    isNewLevelBest: result.score > previousBest,
  };
}

export function chooseBrainPetTask<T extends PlayableBrainPetTaskId>(available: readonly T[], seed: number, recentTaskIds: readonly T[]): T {
  if (available.length === 0) throw new Error("BrainPet requires at least one playable task.");
  const lastTwo = recentTaskIds.slice(0, 2);
  if (lastTwo.length === 2 && lastTwo[0] === lastTwo[1]) {
    const alternatives = available.filter((taskId) => taskId !== lastTwo[0]);
    if (alternatives.length > 0) return alternatives[Math.abs(seed) % alternatives.length]!;
  }
  return available[Math.abs(seed) % available.length]!;
}

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
