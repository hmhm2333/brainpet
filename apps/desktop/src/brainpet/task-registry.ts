import type { BrainPetTaskId, BrainPetTaskManifest } from "./task-contract.js";

const TASK_MANIFESTS: Readonly<Record<BrainPetTaskId, BrainPetTaskManifest>> = {
  "cargo-signal": { apiVersion: 1, id: "cargo-signal", title: "装箱，还是放过", introRule: "蓝印装箱，红印放过", durationMs: 45_000, supportsSeed: true, taskVersion: "1.1.0", assetVersion: "1.0.0", scoring: { version: "brainpet-score-v1", correctPoints: 100, incorrectPoints: -40 }, difficulty: { policyVersion: "brainpet-block-v1", parameterVersion: "1.0.0", maxLevel: 10, blockCount: 3, passAccuracy: 0.75, minimumCorrect: 6 } },
  "pack-refresh": { apiVersion: 1, id: "pack-refresh", title: "行囊不重样", introRule: "记住行囊，找出刚移出的物品", durationMs: 45_000, supportsSeed: true, taskVersion: "1.1.0", assetVersion: "1.0.0", scoring: { version: "brainpet-score-v1", correctPoints: 140, incorrectPoints: -35 }, difficulty: { policyVersion: "brainpet-block-v1", parameterVersion: "1.0.0", maxLevel: 10, blockCount: 3, passAccuracy: 0.75, minimumCorrect: 4 } },
  "stage-exerciser": { apiVersion: 1, id: "stage-exerciser", title: "舞台校验器", introRule: "验证输入、计时与舞台生命周期", durationMs: 45_000, supportsSeed: true, taskVersion: "1.0.0", assetVersion: "1.0.0", scoring: { version: "brainpet-score-v1", correctPoints: 10, incorrectPoints: 0 }, difficulty: { policyVersion: "brainpet-block-v1", parameterVersion: "1.0.0", maxLevel: 1, blockCount: 3, passAccuracy: 0.5, minimumCorrect: 1 } },
};

const PLAYABLE_TASK_IDS = ["cargo-signal", "pack-refresh"] as const;

export function getBrainPetTaskManifest(taskId: BrainPetTaskId): BrainPetTaskManifest {
  return TASK_MANIFESTS[taskId];
}

export function listPlayableBrainPetTaskIds(): readonly (typeof PLAYABLE_TASK_IDS)[number][] {
  return PLAYABLE_TASK_IDS;
}

export function isPlayableBrainPetTaskId(value: unknown): value is (typeof PLAYABLE_TASK_IDS)[number] {
  return PLAYABLE_TASK_IDS.some((taskId) => taskId === value);
}

export function getBrainPetDifficultyParameters(taskId: BrainPetTaskId, level: number): Readonly<Record<string, number | string | boolean>> {
  const boundedLevel = Math.max(1, Math.min(getBrainPetTaskManifest(taskId).difficulty.maxLevel, Math.round(level)));
  if (taskId === "cargo-signal") return {
    responseWindowMs: Math.max(620, 1_050 - (boundedLevel - 1) * 38),
    blockStepMs: 70,
    goProbabilityPercent: Math.max(62, 72 - Math.floor((boundedLevel - 1) / 3) * 3),
    similarityTier: Math.min(3, 1 + Math.floor((boundedLevel - 1) / 3)),
  };
  if (taskId === "pack-refresh") return {
    capacity: Math.min(5, 3 + Math.floor((boundedLevel - 1) / 3)),
    responseWindowMs: Math.max(1_800, 3_300 - (boundedLevel - 1) * 110),
    blockStepMs: 140,
    candidateCount: 2,
    similarityTier: Math.min(3, 1 + Math.floor((boundedLevel - 1) / 3)),
  };
  return { responseWindowMs: 45_000, blockStepMs: 0 };
}
