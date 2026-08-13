export const BRAINPET_TASK_API_VERSION = 1 as const;

export type BrainPetTaskId = "stage-exerciser" | "cargo-signal" | "pack-refresh";

export interface BrainPetTaskManifest {
  readonly apiVersion: typeof BRAINPET_TASK_API_VERSION;
  readonly id: BrainPetTaskId;
  readonly title: string;
  readonly durationMs: number;
  readonly supportsSeed: true;
  readonly taskVersion: string;
  readonly assetVersion: string;
  readonly scoring: {
    readonly version: "brainpet-score-v1";
    readonly correctPoints: number;
    readonly incorrectPoints: number;
  };
}

export interface BrainPetTaskSessionConfig {
  readonly taskId: BrainPetTaskId;
  readonly seed: number;
  readonly durationMs: number;
  readonly level: number;
  readonly difficultyPolicyVersion: string;
}

export interface BrainPetTrialRecord {
  readonly stimulusId: string;
  readonly stimulusKind: string;
  readonly plannedAtMs: number;
  readonly presentedAtMs: number;
  readonly inputType: "primary" | "secondary" | "none";
  readonly inputAtMs: number | null;
  readonly correct: boolean;
  readonly reactionTimeMs: number | null;
}

export interface BrainPetResultQuality {
  readonly valid: boolean;
  readonly focusLossCount: number;
  readonly pausedMs: number;
  readonly droppedFrameCount: number;
  readonly longFrameCount: number;
  readonly maxFrameMs: number;
  readonly flags: readonly string[];
}

export type BrainPetTaskInput =
  | { readonly type: "primary"; readonly atMs: number }
  | { readonly type: "secondary"; readonly atMs: number }
  | { readonly type: "pause"; readonly atMs: number }
  | { readonly type: "resume"; readonly atMs: number };

export interface BrainPetTaskResult {
  readonly taskId: BrainPetTaskId;
  readonly seed: number;
  readonly score: number;
  readonly correct: number;
  readonly incorrect: number;
  readonly missed: number;
  readonly durationMs: number;
  readonly completedAt: string;
  readonly taskVersion: string;
  readonly assetVersion: string;
  readonly difficultyPolicyVersion: string;
  readonly scoreVersion: string;
  readonly level: number;
  readonly falseAlarms: number;
  readonly meanReactionTimeMs: number | null;
  readonly trials: readonly BrainPetTrialRecord[];
  readonly quality: BrainPetResultQuality;
  readonly petEvents: readonly ("complete" | "stable" | "new-best")[];
}

export function validateBrainPetTaskManifest(value: unknown): BrainPetTaskManifest {
  if (!isRecord(value)) throw new Error("BrainPet task manifest must be an object.");
  if (value.apiVersion !== BRAINPET_TASK_API_VERSION) throw new Error("Unsupported BrainPet task API version.");
  if (!isTaskId(value.id)) throw new Error("Unknown BrainPet task id.");
  if (typeof value.title !== "string" || value.title.trim().length === 0 || value.title.length > 48) {
    throw new Error("BrainPet task title must contain 1-48 characters.");
  }
  if (!Number.isInteger(value.durationMs) || (value.durationMs as number) < 10_000 || (value.durationMs as number) > 120_000) {
    throw new Error("BrainPet task duration must be between 10 and 120 seconds.");
  }
  if (value.supportsSeed !== true) throw new Error("BrainPet V1 tasks must support deterministic seeds.");
  if (!isSemanticVersion(value.taskVersion) || !isSemanticVersion(value.assetVersion)) {
    throw new Error("BrainPet task and asset versions must use semantic versions.");
  }
  if (!isRecord(value.scoring) || value.scoring.version !== "brainpet-score-v1" || !Number.isInteger(value.scoring.correctPoints) || !Number.isInteger(value.scoring.incorrectPoints)) {
    throw new Error("BrainPet task scoring must use a bounded versioned declaration.");
  }
  if (Math.abs(value.scoring.correctPoints as number) > 1_000 || Math.abs(value.scoring.incorrectPoints as number) > 1_000) throw new Error("BrainPet score weights are out of range.");
  return value as unknown as BrainPetTaskManifest;
}

export function computeDeclaredScore(manifest: BrainPetTaskManifest, trials: readonly BrainPetTrialRecord[]): number {
  const score = trials.reduce((total, trial) => total + (trial.correct ? manifest.scoring.correctPoints : manifest.scoring.incorrectPoints), 0);
  return Math.max(0, Math.round(score));
}

export function isTaskId(value: unknown): value is BrainPetTaskId {
  return value === "stage-exerciser" || value === "cargo-signal" || value === "pack-refresh";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSemanticVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}
