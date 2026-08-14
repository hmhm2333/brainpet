import { validateBrainPetTaskManifest, type BrainPetTaskId, type BrainPetTaskManifest, type BrainPetTrialRecord } from "./task-contract.js";

export interface BrainPetTaskDefinition {
  readonly manifest: BrainPetTaskManifest;
  readonly playable: boolean;
  readonly parametersForLevel: (level: number) => Readonly<Record<string, number | string | boolean>>;
  readonly expectedInputForTrial: (trial: BrainPetTrialRecord) => BrainPetTrialRecord["inputType"] | null;
  readonly trialKindsForSession?: (seed: number, parameters: Readonly<Record<string, number | string | boolean>>) => readonly string[];
}

export interface CargoSignalTrialPlanItem {
  readonly kind: "go" | "no-go";
  readonly flightMs: number;
  readonly arcHeightPx: number;
  readonly curveOffsetPx: number;
  readonly spinTurns: number;
  readonly cargoVariant: 0 | 1 | 2;
  readonly itiMs: number;
}

const FOUNDATION_PROBE_SPRITE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' fill='%23f5bd3d'/%3E%3Cpath d='M6 12h12M12 6v12' stroke='%2317243b' stroke-width='3'/%3E%3C/svg%3E";
const CARGO_GO_SPRITE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48' shape-rendering='crispEdges'%3E%3Cpath fill='%2317243b' d='M8 4h32v4h4v32h-4v4H8v-4H4V8h4z'/%3E%3Cpath fill='%2370c9e8' d='M8 8h32v32H8z'/%3E%3Cpath fill='%23237491' d='M8 32h32v8H8z'/%3E%3Cpath fill='%23f5bd3d' d='M20 8h8v32h-8z'/%3E%3Cpath fill='%23fff7dc' d='M12 17h24v14H12z'/%3E%3Cpath fill='%23237491' d='M18 21h12v6H18z'/%3E%3C/svg%3E";
const CARGO_NO_GO_SPRITE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48' shape-rendering='crispEdges'%3E%3Cpath fill='%2317243b' d='M8 4h32v4h4v32h-4v4H8v-4H4V8h4z'/%3E%3Cpath fill='%23d95b66' d='M8 8h32v32H8z'/%3E%3Cpath fill='%238f2f51' d='M8 32h32v8H8z'/%3E%3Cpath fill='%23fff7dc' d='M13 12h7v7h-7zm15 0h7v7h-7zM20 19h8v10h-8zm-7 10h7v7h-7zm15 0h7v7h-7z'/%3E%3C/svg%3E";
const CARGO_DOCK_SPRITE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='48' viewBox='0 0 72 48' shape-rendering='crispEdges'%3E%3Cpath fill='%2317243b' d='M8 12h56v4h4v28h-4v4H8v-4H4V16h4z'/%3E%3Cpath fill='%23d9952f' d='M8 16h56v28H8z'/%3E%3Cpath fill='%23f5bd3d' d='M8 16h56v10H8z'/%3E%3Cpath fill='%2370c9e8' d='M18 4h36v4h6v12H12V8h6z'/%3E%3Cpath fill='%23fff7dc' d='M31 26h10v10H31z'/%3E%3Cpath fill='%2317243b' d='M34 28h4v6h-4z'/%3E%3C/svg%3E";
const CARGO_GO_CAPSULE_SPRITE = pixelSprite("<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48' shape-rendering='crispEdges'><path fill='#17243b' d='M12 8h24v4h4v24h-4v4H12v-4H8V12h4z'/><path fill='#70c9e8' d='M12 12h24v24H12z'/><path fill='#237491' d='M12 28h24v8H12z'/><path fill='#fff7dc' d='M20 12h8v24h-8z'/><path fill='#f5bd3d' d='M16 19h16v10H16z'/></svg>");
const CARGO_NO_GO_CAPSULE_SPRITE = pixelSprite("<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48' shape-rendering='crispEdges'><path fill='#17243b' d='M12 8h24v4h4v24h-4v4H12v-4H8V12h4z'/><path fill='#d95b66' d='M12 12h24v24H12z'/><path fill='#8f2f51' d='M12 28h24v8H12z'/><path fill='#fff7dc' d='M16 16h6v6h-6zm10 0h6v6h-6zm-5 7h6v7h-6zm-5 7h6v6h-6zm10 0h6v6h-6z'/></svg>");
const CARGO_GO_ORB_SPRITE = pixelSprite("<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48' shape-rendering='crispEdges'><path fill='#17243b' d='M16 4h16v4h8v8h4v16h-4v8h-8v4H16v-4H8v-8H4V16h4V8h8z'/><path fill='#70c9e8' d='M16 8h16v4h8v24h-8v4H16v-4H8V12h8z'/><path fill='#237491' d='M12 28h24v8h-4v4H16v-4h-4z'/><path fill='#fff7dc' d='M16 13h10v6H16z'/><path fill='#f5bd3d' d='M20 21h8v8h-8z'/></svg>");
const CARGO_NO_GO_ORB_SPRITE = pixelSprite("<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48' shape-rendering='crispEdges'><path fill='#17243b' d='M16 4h16v4h8v8h4v16h-4v8h-8v4H16v-4H8v-8H4V16h4V8h8z'/><path fill='#d95b66' d='M16 8h16v4h8v24h-8v4H16v-4H8V12h8z'/><path fill='#8f2f51' d='M12 28h24v8h-4v4H16v-4h-4z'/><path fill='#fff7dc' d='M15 15h6v6h-6zm12 0h6v6h-6zm-6 7h6v7h-6zm-6 7h6v6h-6zm12 0h6v6h-6z'/></svg>");

const TASK_DEFINITIONS: readonly BrainPetTaskDefinition[] = [
  define(
    {
      apiVersion: 1,
      id: "cargo-signal",
      title: "装箱，还是放过",
      introRule: "接住蓝色补给，放过红色故障包",
      durationMs: 45_000,
      supportsSeed: true,
      taskVersion: "2.3.0",
      assetVersion: "2.1.0",
      assets: [
        { id: "cargo-go", version: "2.0.0", kind: "sprite", url: CARGO_GO_SPRITE, fallback: CARGO_GO_SPRITE },
        { id: "cargo-no-go", version: "2.0.0", kind: "sprite", url: CARGO_NO_GO_SPRITE, fallback: CARGO_NO_GO_SPRITE },
        { id: "cargo-go-capsule", version: "2.1.0", kind: "sprite", url: CARGO_GO_CAPSULE_SPRITE, fallback: CARGO_GO_CAPSULE_SPRITE },
        { id: "cargo-no-go-capsule", version: "2.1.0", kind: "sprite", url: CARGO_NO_GO_CAPSULE_SPRITE, fallback: CARGO_NO_GO_CAPSULE_SPRITE },
        { id: "cargo-go-orb", version: "2.1.0", kind: "sprite", url: CARGO_GO_ORB_SPRITE, fallback: CARGO_GO_ORB_SPRITE },
        { id: "cargo-no-go-orb", version: "2.1.0", kind: "sprite", url: CARGO_NO_GO_ORB_SPRITE, fallback: CARGO_NO_GO_ORB_SPRITE },
        { id: "cargo-dock", version: "2.0.0", kind: "sprite", url: CARGO_DOCK_SPRITE, fallback: CARGO_DOCK_SPRITE },
      ],
      scoring: { version: "brainpet-score-v2", goBasePoints: 40, goMaxPoints: 200, noGoCorrectPoints: 40, falseAlarmPoints: -40, goMissPoints: -20 },
      difficulty: { policyVersion: "brainpet-block-v1", parameterVersion: "2.2.0", maxLevel: 10, blockCount: 3, passAccuracy: 0.75, minimumCorrect: 18, minimumCorrectInhibitions: 5 },
    },
    true,
    (level) => ({ trialCount: 24, goCount: 18, noGoCount: 6, responseWindowMs: Math.max(470, 650 - (level - 1) * 20), fastRtMs: 220, feedbackMs: 220, itiMinMs: 120, itiMaxMs: 160 }),
    (trial) => trial.stimulusKind === "go" ? "primary" : trial.stimulusKind === "no-go" || trial.stimulusKind === "anticipation" ? "none" : null,
    (seed, parameters) => createCargoSignalTrialPlan(seed, parameters).map((trial) => trial.kind),
  ),
  define(
    {
      apiVersion: 1,
      id: "pack-refresh",
      title: "行囊不重样",
      introRule: "记住行囊，找出刚移出的物品",
      durationMs: 45_000,
      supportsSeed: true,
      taskVersion: "1.2.0",
      assetVersion: "1.1.0",
      scoring: { version: "brainpet-score-v1", correctPoints: 140, incorrectPoints: -35 },
      difficulty: { policyVersion: "brainpet-block-v1", parameterVersion: "1.1.0", maxLevel: 10, blockCount: 3, passAccuracy: 0.75, minimumCorrect: 4 },
    },
    false,
    (level) => ({ capacity: Math.min(5, 3 + Math.floor((level - 1) / 3)), responseWindowMs: Math.max(1_800, 3_300 - (level - 1) * 110), blockStepMs: 140 }),
    (trial) => trial.stimulusKind === "continuous-update-left" ? "primary" : trial.stimulusKind === "continuous-update-right" ? "secondary" : null,
  ),
  define(
    {
      apiVersion: 1,
      id: "stage-exerciser",
      title: "舞台校验器",
      introRule: "验证输入、计时与舞台生命周期",
      durationMs: 45_000,
      supportsSeed: true,
      taskVersion: "1.0.0",
      assetVersion: "1.0.0",
      scoring: { version: "brainpet-score-v1", correctPoints: 10, incorrectPoints: 0 },
      difficulty: { policyVersion: "brainpet-block-v1", parameterVersion: "1.0.0", maxLevel: 1, blockCount: 3, passAccuracy: 0.5, minimumCorrect: 1 },
    },
    false,
    () => ({ responseWindowMs: 45_000, blockStepMs: 0 }),
    (trial) => trial.stimulusKind === "input-echo-primary" ? "primary" : trial.stimulusKind === "input-echo-secondary" ? "secondary" : null,
  ),
  define(
    {
      apiVersion: 1,
      id: "foundation-probe",
      title: "异构舞台探针",
      introRule: "验证资源、场景与多目标输入",
      durationMs: 10_000,
      supportsSeed: true,
      taskVersion: "1.0.0",
      assetVersion: "1.0.0",
      assets: [{ id: "probe-gem", version: "1.0.0", kind: "sprite", url: FOUNDATION_PROBE_SPRITE, fallback: FOUNDATION_PROBE_SPRITE }],
      scoring: { version: "brainpet-score-v1", correctPoints: 10, incorrectPoints: -5 },
      difficulty: { policyVersion: "brainpet-block-v1", parameterVersion: "1.0.0", maxLevel: 1, blockCount: 3, passAccuracy: 0.5, minimumCorrect: 1 },
    },
    false,
    () => ({ responseWindowMs: 10_000, blockStepMs: 0 }),
    (trial) => trial.stimulusKind === "probe-left" ? "primary" : trial.stimulusKind === "probe-right" ? "secondary" : null,
  ),
];

const TASK_DEFINITIONS_BY_ID = new Map(TASK_DEFINITIONS.map((definition) => [definition.manifest.id, definition]));

export function getBrainPetTaskManifest(taskId: BrainPetTaskId): BrainPetTaskManifest {
  return getBrainPetTaskDefinition(taskId).manifest;
}

export function getBrainPetTaskDefinition(taskId: BrainPetTaskId): BrainPetTaskDefinition {
  const definition = TASK_DEFINITIONS_BY_ID.get(taskId);
  if (!definition) throw new Error(`Unknown BrainPet task: ${taskId}`);
  return definition;
}

export function listPlayableBrainPetTaskIds(): readonly BrainPetTaskId[] {
  return TASK_DEFINITIONS.filter((definition) => definition.playable).map((definition) => definition.manifest.id);
}

export function isPlayableBrainPetTaskId(value: unknown): value is BrainPetTaskId {
  return typeof value === "string" && TASK_DEFINITIONS_BY_ID.get(value)?.playable === true;
}

export function isRegisteredBrainPetTaskId(value: unknown): value is BrainPetTaskId {
  return typeof value === "string" && TASK_DEFINITIONS_BY_ID.has(value);
}

export function getBrainPetDifficultyParameters(taskId: BrainPetTaskId, level: number): Readonly<Record<string, number | string | boolean>> {
  const definition = getBrainPetTaskDefinition(taskId);
  const boundedLevel = Math.max(1, Math.min(definition.manifest.difficulty.maxLevel, Math.round(level)));
  return definition.parametersForLevel(boundedLevel);
}

export function createCargoSignalTrialPlan(seed: number, parameters: Readonly<Record<string, number | string | boolean>>): readonly CargoSignalTrialPlanItem[] {
  const random = seededRandom(seed);
  const goCount = boundedCount(parameters.goCount, 18, 1, 64);
  const noGoCount = boundedCount(parameters.noGoCount, 6, 1, 32);
  const base = [...Array.from({ length: goCount }, () => "go" as const), ...Array.from({ length: noGoCount }, () => "no-go" as const)];
  let kinds: Array<"go" | "no-go"> | null = null;
  for (let attempt = 0; attempt < 2_048 && !kinds; attempt += 1) {
    const candidate = shuffle(random, base);
    if (isConstrainedCargoSequence(candidate)) kinds = candidate;
  }
  if (!kinds) throw new Error("Unable to create a constrained cargo-signal trial sequence.");
  const responseWindowMs = boundedCount(parameters.responseWindowMs, 900, 200, 2_000);
  const itiMinMs = boundedCount(parameters.itiMinMs, 120, 0, 2_000);
  const itiMaxMs = boundedCount(parameters.itiMaxMs, 260, itiMinMs, 2_000);
  const arcs = [88, 112, 136, 160] as const;
  const curveOffsets = [-52, 0, 52] as const;
  return kinds.map((kind) => {
    const cargoVariant = Math.min(2, Math.floor(random() * 3)) as 0 | 1 | 2;
    return {
      kind,
      flightMs: responseWindowMs,
      arcHeightPx: arcs[Math.min(arcs.length - 1, Math.floor(random() * arcs.length))]!,
      curveOffsetPx: curveOffsets[Math.min(curveOffsets.length - 1, Math.floor(random() * curveOffsets.length))]!,
      spinTurns: random() < 0.5 ? -1 : 1,
      cargoVariant,
      itiMs: Math.round(itiMinMs + random() * (itiMaxMs - itiMinMs)),
    };
  });
}

function pixelSprite(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function define(
  manifest: BrainPetTaskManifest,
  playable: boolean,
  parametersForLevel: BrainPetTaskDefinition["parametersForLevel"],
  expectedInputForTrial: BrainPetTaskDefinition["expectedInputForTrial"],
  trialKindsForSession?: BrainPetTaskDefinition["trialKindsForSession"],
): BrainPetTaskDefinition {
  return { manifest: validateBrainPetTaskManifest(manifest), playable, parametersForLevel, expectedInputForTrial, ...(trialKindsForSession ? { trialKindsForSession } : {}) };
}

function isConstrainedCargoSequence(sequence: readonly ("go" | "no-go")[]): boolean {
  if (sequence[0] !== "go") return false;
  let runKind: "go" | "no-go" = sequence[0];
  let runLength = 0;
  for (const kind of sequence) {
    if (kind === runKind) runLength += 1;
    else { runKind = kind; runLength = 1; }
    if (kind === "go" && runLength > 4 || kind === "no-go" && runLength > 2) return false;
  }
  return true;
}

function shuffle<T>(random: () => number, values: readonly T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0 || 1;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4_294_967_296;
  };
}

function boundedCount(value: number | string | boolean | undefined, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}
