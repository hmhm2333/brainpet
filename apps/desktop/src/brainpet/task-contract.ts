export const BRAINPET_TASK_API_VERSION = 1 as const;

export type BrainPetTaskId = string;

export interface BrainPetTaskAssetDeclaration {
  readonly id: string;
  readonly version: string;
  readonly kind: "sprite" | "sound";
  readonly url: string;
  readonly fallback: string;
}

export interface BrainPetTaskManifest {
  readonly apiVersion: typeof BRAINPET_TASK_API_VERSION;
  readonly id: BrainPetTaskId;
  readonly title: string;
  readonly introRule: string;
  readonly durationMs: number;
  readonly supportsSeed: true;
  readonly taskVersion: string;
  readonly assetVersion: string;
  readonly assets?: readonly BrainPetTaskAssetDeclaration[];
  readonly scoring:
    | { readonly version: "brainpet-score-v1"; readonly correctPoints: number; readonly incorrectPoints: number }
    | { readonly version: "brainpet-score-v2"; readonly goBasePoints: number; readonly goMaxPoints: number; readonly noGoCorrectPoints: number; readonly falseAlarmPoints: number; readonly goMissPoints: number };
  readonly difficulty: {
    readonly policyVersion: "brainpet-block-v1";
    readonly parameterVersion: string;
    readonly maxLevel: number;
    readonly blockCount: 3;
    readonly passAccuracy: number;
    readonly minimumCorrect: number;
    readonly minimumCorrectInhibitions?: number;
  };
}

export interface BrainPetTaskSessionConfig {
  readonly taskId: BrainPetTaskId;
  readonly seed: number;
  readonly durationMs: number;
  readonly level: number;
  readonly difficultyPolicyVersion: string;
  readonly parameterVersion: string;
  readonly parameters: Readonly<Record<string, number | string | boolean>>;
  readonly blockCount: 3;
}

export interface BrainPetTrialRecord {
  readonly stimulusId: string;
  readonly stimulusKind: string;
  readonly blockIndex: 1 | 2 | 3;
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
  readonly startedAt: string;
  readonly completedAt: string;
  readonly completionStatus: "completed";
  readonly taskVersion: string;
  readonly assetVersion: string;
  readonly difficultyPolicyVersion: string;
  readonly parameterVersion: string;
  readonly parameters: Readonly<Record<string, number | string | boolean>>;
  readonly blockCount: 3;
  readonly scoreVersion: string;
  readonly level: number;
  readonly falseAlarms: number;
  readonly meanReactionTimeMs: number | null;
  readonly trials: readonly BrainPetTrialRecord[];
  readonly quality: BrainPetResultQuality;
  readonly petEvents: readonly ("complete" | "stable" | "new-best")[];
  readonly progression?: {
    readonly passed: boolean;
    readonly previousLevel: number;
    readonly nextLevel: number;
    readonly accuracy: number;
  };
}

export function validateBrainPetTaskManifest(value: unknown): BrainPetTaskManifest {
  if (!isRecord(value)) throw new Error("BrainPet task manifest must be an object.");
  if (value.apiVersion !== BRAINPET_TASK_API_VERSION) throw new Error("Unsupported BrainPet task API version.");
  if (!isTaskId(value.id)) throw new Error("Unknown BrainPet task id.");
  if (typeof value.title !== "string" || value.title.trim().length === 0 || value.title.length > 48) {
    throw new Error("BrainPet task title must contain 1-48 characters.");
  }
  if (typeof value.introRule !== "string" || value.introRule.trim().length === 0 || value.introRule.length > 64) throw new Error("BrainPet task intro rule must contain 1-64 characters.");
  if (!Number.isInteger(value.durationMs) || (value.durationMs as number) < 10_000 || (value.durationMs as number) > 120_000) {
    throw new Error("BrainPet task duration must be between 10 and 120 seconds.");
  }
  if (value.supportsSeed !== true) throw new Error("BrainPet V1 tasks must support deterministic seeds.");
  if (!isSemanticVersion(value.taskVersion) || !isSemanticVersion(value.assetVersion)) {
    throw new Error("BrainPet task and asset versions must use semantic versions.");
  }
  if (value.assets !== undefined) {
    if (!Array.isArray(value.assets) || value.assets.length > 64) throw new Error("BrainPet task assets are invalid.");
    const assetIds = new Set<string>();
    for (const asset of value.assets) {
      if (!isRecord(asset) || typeof asset.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(asset.id) || assetIds.has(asset.id) || !isSemanticVersion(asset.version) || (asset.kind !== "sprite" && asset.kind !== "sound") || typeof asset.url !== "string" || asset.url.length === 0 || asset.url.length > 4_096 || typeof asset.fallback !== "string" || asset.fallback.length === 0 || asset.fallback.length > 4_096) throw new Error("BrainPet task assets are invalid.");
      assetIds.add(asset.id);
    }
  }
  if (!isRecord(value.scoring) || !isValidScoring(value.scoring)) {
    throw new Error("BrainPet task scoring must use a bounded versioned declaration.");
  }
  if (!isRecord(value.difficulty)
    || value.difficulty.policyVersion !== "brainpet-block-v1"
    || !isSemanticVersion(value.difficulty.parameterVersion)
    || !Number.isInteger(value.difficulty.maxLevel) || (value.difficulty.maxLevel as number) < 1 || (value.difficulty.maxLevel as number) > 100
    || value.difficulty.blockCount !== 3
    || typeof value.difficulty.passAccuracy !== "number" || value.difficulty.passAccuracy < 0.5 || value.difficulty.passAccuracy > 1
    || !Number.isInteger(value.difficulty.minimumCorrect) || (value.difficulty.minimumCorrect as number) < 1
    || (value.difficulty.minimumCorrectInhibitions !== undefined && (!Number.isInteger(value.difficulty.minimumCorrectInhibitions) || (value.difficulty.minimumCorrectInhibitions as number) < 1))) {
    throw new Error("BrainPet task difficulty declaration is invalid.");
  }
  return value as unknown as BrainPetTaskManifest;
}

export function computeBrainPetTrialScore(manifest: BrainPetTaskManifest, trial: BrainPetTrialRecord, parameters: Readonly<Record<string, number | string | boolean>> = {}): number {
  const scoring = manifest.scoring;
  if (scoring.version === "brainpet-score-v1") return trial.correct ? scoring.correctPoints : scoring.incorrectPoints;
  if (trial.stimulusKind === "no-go") return trial.inputType === "none" ? scoring.noGoCorrectPoints : scoring.falseAlarmPoints;
  if (trial.stimulusKind !== "go") return 0;
  if (trial.inputType === "none") return scoring.goMissPoints;
  const responseWindowMs = numberParameter(parameters, "responseWindowMs", 900);
  const fastRtMs = numberParameter(parameters, "fastRtMs", 220);
  const reactionTimeMs = Math.max(0, trial.reactionTimeMs ?? responseWindowMs);
  const denominator = Math.max(1, responseWindowMs - fastRtMs);
  const speedRatio = Math.min(1, Math.max(0, (responseWindowMs - reactionTimeMs) / denominator));
  const speedPoints = Math.round(((scoring.goMaxPoints - scoring.goBasePoints) * speedRatio) / 5) * 5;
  return scoring.goBasePoints + speedPoints;
}

export function computeDeclaredScore(manifest: BrainPetTaskManifest, trials: readonly BrainPetTrialRecord[], parameters: Readonly<Record<string, number | string | boolean>> = {}): number {
  const score = trials.reduce((total, trial) => total + computeBrainPetTrialScore(manifest, trial, parameters), 0);
  return Math.max(0, Math.round(score));
}

export function canonicalizeBrainPetTaskResult(
  manifest: BrainPetTaskManifest,
  result: BrainPetTaskResult,
  expectedInputForTrial: (trial: BrainPetTrialRecord) => BrainPetTrialRecord["inputType"] | null,
): BrainPetTaskResult | null {
  const trials: BrainPetTrialRecord[] = [];
  for (const trial of result.trials) {
    const expectedInput = expectedInputForTrial(trial);
    if (expectedInput === null) return null;
    const reactionTimeMs = trial.inputAtMs === null ? null : Math.max(0, trial.inputAtMs - trial.presentedAtMs);
    trials.push({ ...trial, correct: trial.inputType === expectedInput, reactionTimeMs });
  }
  const correct = trials.filter((trial) => trial.correct).length;
  const incorrect = trials.filter((trial) => !trial.correct && trial.inputType !== "none").length;
  const missed = trials.filter((trial) => !trial.correct && trial.inputType === "none").length;
  const falseAlarms = trials.filter((trial) => trial.stimulusKind === "no-go" && !trial.correct && trial.inputType !== "none").length;
  const reactionTimes = trials.flatMap((trial) => trial.stimulusKind === "go" && trial.correct && trial.reactionTimeMs !== null ? [trial.reactionTimeMs] : []);
  const meanReactionTimeMs = reactionTimes.length === 0 ? null : Math.round(reactionTimes.reduce((total, item) => total + item, 0) / reactionTimes.length);
  const flags = [...result.quality.flags];
  const quality = { ...result.quality, valid: !flags.includes("excessive-frame-loss"), flags };
  const score = computeDeclaredScore(manifest, trials, result.parameters);
  return {
    ...result,
    score,
    correct,
    incorrect,
    missed,
    falseAlarms,
    meanReactionTimeMs,
    trials,
    quality,
    petEvents: ["complete", ...(correct > incorrect ? ["stable" as const] : [])],
  };
}

export function isTaskId(value: unknown): value is BrainPetTaskId {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSemanticVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

function isValidScoring(value: Record<string, unknown>): boolean {
  if (value.version === "brainpet-score-v1") return boundedInteger(value.correctPoints) && boundedInteger(value.incorrectPoints);
  return value.version === "brainpet-score-v2"
    && boundedInteger(value.goBasePoints) && boundedInteger(value.goMaxPoints) && (value.goMaxPoints as number) >= (value.goBasePoints as number)
    && boundedInteger(value.noGoCorrectPoints) && boundedInteger(value.falseAlarmPoints) && boundedInteger(value.goMissPoints);
}

function boundedInteger(value: unknown): boolean {
  return Number.isInteger(value) && Math.abs(value as number) <= 1_000;
}

function numberParameter(parameters: Readonly<Record<string, number | string | boolean>>, name: string, fallback: number): number {
  const value = parameters[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
