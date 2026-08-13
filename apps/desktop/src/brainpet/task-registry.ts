import type { BrainPetTaskId, BrainPetTaskManifest } from "./task-contract.js";

const TASK_MANIFESTS: Readonly<Record<BrainPetTaskId, BrainPetTaskManifest>> = {
  "cargo-signal": { apiVersion: 1, id: "cargo-signal", title: "装箱，还是放过", durationMs: 45_000, supportsSeed: true, taskVersion: "1.0.0", assetVersion: "1.0.0", scoring: { version: "brainpet-score-v1", correctPoints: 100, incorrectPoints: -40 } },
  "pack-refresh": { apiVersion: 1, id: "pack-refresh", title: "行囊不重样", durationMs: 45_000, supportsSeed: true, taskVersion: "1.0.0", assetVersion: "1.0.0", scoring: { version: "brainpet-score-v1", correctPoints: 140, incorrectPoints: -35 } },
  "stage-exerciser": { apiVersion: 1, id: "stage-exerciser", title: "舞台校验器", durationMs: 45_000, supportsSeed: true, taskVersion: "1.0.0", assetVersion: "1.0.0", scoring: { version: "brainpet-score-v1", correctPoints: 10, incorrectPoints: 0 } },
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
