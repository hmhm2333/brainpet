import { computeBrainPetTrialScore, type BrainPetTaskId, type BrainPetTaskInput, type BrainPetTaskManifest, type BrainPetTaskResult, type BrainPetTrialRecord } from "../../../brainpet/task-contract.js";
import { createCargoSignalTrialPlan, getBrainPetDifficultyParameters, getBrainPetTaskManifest, type CargoSignalTrialPlanItem } from "../../../brainpet/task-registry.js";
import { validateStageScene, type StageScene } from "./stage-services.js";

export interface BrainPetTaskFrame {
  readonly eyebrow: string;
  readonly title: string;
  readonly instruction: string;
  readonly symbol: string;
  readonly tone: "sky" | "gold" | "mint" | "rose";
  readonly slots?: readonly string[];
  readonly choices?: readonly string[];
  readonly feedback?: "correct" | "incorrect" | "neutral";
  readonly feedbackText?: string;
  readonly feedbackScore?: number;
  readonly primarySurface?: boolean;
  readonly combo?: number;
  readonly progress: number;
  readonly score: number;
  readonly scene?: StageScene;
}

export interface BrainPetTaskModule {
  readonly manifest: BrainPetTaskManifest;
  readonly frame: BrainPetTaskFrame;
  readonly finished: boolean;
  start(seed: number, level: number, nowMs: number, parameters?: Readonly<Record<string, number | string | boolean>>): void;
  input(input: BrainPetTaskInput): void;
  tick(nowMs: number): void;
  restartActiveTrial(nowMs: number): boolean;
  result(nowMs: number): BrainPetTaskResult;
}

const PACK_SYMBOLS = ["⚙", "✦", "◆", "●", "▲", "■", "★", "⬢", "✚", "◇"] as const;

export function createTaskModule(taskId: BrainPetTaskId): BrainPetTaskModule {
  const factory = TASK_MODULE_FACTORIES.get(taskId);
  if (!factory) throw new Error(`No BrainPet renderer module registered for ${taskId}.`);
  return factory();
}

const TASK_MODULE_FACTORIES = new Map<string, () => BrainPetTaskModule>([
  ["cargo-signal", () => new CargoSignalTask()],
  ["pack-refresh", () => new PackRefreshTask()],
  ["stage-exerciser", () => new StageExerciserTask()],
  ["foundation-probe", () => new FoundationProbeTask()],
]);

abstract class BaseTask implements BrainPetTaskModule {
  abstract readonly manifest: BrainPetTaskManifest;
  abstract frame: BrainPetTaskFrame;
  finished = false;
  protected seed = 1;
  protected level = 1;
  protected startedAt = 0;
  protected startedAtIso = "";
  protected correct = 0;
  protected incorrect = 0;
  protected missed = 0;
  protected falseAlarms = 0;
  protected score = 0;
  protected combo = 0;
  protected trials: BrainPetTrialRecord[] = [];
  protected random: () => number = () => 0;
  protected parameters: Readonly<Record<string, number | string | boolean>> = {};

  start(seed: number, level: number, nowMs: number, parameters = getBrainPetDifficultyParameters(this.manifest.id, level)): void {
    this.seed = seed >>> 0 || 1;
    this.level = level;
    this.startedAt = nowMs;
    this.startedAtIso = new Date().toISOString();
    this.correct = 0;
    this.incorrect = 0;
    this.missed = 0;
    this.falseAlarms = 0;
    this.score = 0;
    this.combo = 0;
    this.trials = [];
    this.finished = false;
    this.random = seededRandom(this.seed);
    this.parameters = { ...parameters };
    this.onStart(nowMs);
  }

  abstract input(input: BrainPetTaskInput): void;
  abstract tick(nowMs: number): void;
  protected abstract onStart(nowMs: number): void;

  restartActiveTrial(_nowMs: number): boolean {
    return false;
  }

  result(nowMs: number): BrainPetTaskResult {
    return {
      taskId: this.manifest.id,
      seed: this.seed,
      score: Math.max(0, Math.round(this.score)),
      correct: this.correct,
      incorrect: this.incorrect,
      missed: this.missed,
      durationMs: Math.round(Math.min(this.manifest.durationMs, Math.max(0, nowMs - this.startedAt))),
      startedAt: this.startedAtIso,
      completedAt: new Date().toISOString(),
      completionStatus: "completed",
      taskVersion: this.manifest.taskVersion,
      assetVersion: this.manifest.assetVersion,
      difficultyPolicyVersion: "brainpet-block-v1",
      parameterVersion: this.manifest.difficulty.parameterVersion,
      parameters: this.parameters,
      blockCount: this.manifest.difficulty.blockCount,
      scoreVersion: this.manifest.scoring.version,
      level: this.level,
      falseAlarms: this.falseAlarms,
      meanReactionTimeMs: mean(this.trials.flatMap((trial) => trial.reactionTimeMs === null ? [] : [trial.reactionTimeMs])),
      trials: [...this.trials],
      quality: { valid: true, focusLossCount: 0, pausedMs: 0, droppedFrameCount: 0, longFrameCount: 0, maxFrameMs: 0, flags: [] },
      petEvents: ["complete"],
    };
  }

  protected progress(nowMs: number): number {
    return Math.min(1, Math.max(0, (nowMs - this.startedAt) / this.manifest.durationMs));
  }

  protected blockIndex(nowMs: number): 1 | 2 | 3 {
    return Math.min(3, Math.floor(this.progress(nowMs) * this.manifest.difficulty.blockCount) + 1) as 1 | 2 | 3;
  }

  protected numberParameter(name: string, fallback: number): number {
    const value = this.parameters[name];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }
}

class CargoSignalTask extends BaseTask {
  readonly manifest = getBrainPetTaskManifest("cargo-signal");
  frame: BrainPetTaskFrame = emptyFrame();
  private plan: readonly CargoSignalTrialPlanItem[] = [];
  private trialIndex = 0;
  private phase: "flight" | "feedback" | "intertrial" = "flight";
  private phaseStartedAt = 0;
  private phaseEndsAt = 0;
  private trialPlannedAt = 0;
  private stimulusCounter = 0;
  private currentStimulusId = "";

  protected onStart(nowMs: number): void {
    this.plan = createCargoSignalTrialPlan(this.seed, this.parameters);
    this.trialIndex = 0;
    this.startTrial(nowMs);
  }

  input(input: BrainPetTaskInput): void {
    if (input.type !== "primary" || this.finished || this.phase !== "flight") return;
    const correct = this.currentTrial.kind === "go";
    this.finishDecision(this.createTrialRecord("primary", input.atMs, correct), input.atMs);
  }

  tick(nowMs: number): void {
    if (this.finished) return;
    while (!this.finished && nowMs >= this.phaseEndsAt) {
      const transitionAt = this.phaseEndsAt;
      if (this.phase === "flight") {
        const correct = this.currentTrial.kind === "no-go";
        this.finishDecision(this.createTrialRecord("none", null, correct), transitionAt);
      } else if (this.phase === "feedback") {
        if (this.trialIndex >= this.plan.length - 1) {
          this.finished = true;
          this.frame = { ...this.frame, progress: 1, feedback: "neutral", feedbackText: undefined, feedbackScore: undefined, scene: this.createScene(transitionAt) };
        } else this.enterPhase("intertrial", transitionAt, this.currentTrial.itiMs);
      } else {
        this.trialIndex += 1;
        this.startTrial(transitionAt);
      }
    }
    if (!this.finished && this.phase !== "feedback") this.frame = this.createFrame(nowMs);
  }

  restartActiveTrial(nowMs: number): boolean {
    if (this.finished || this.phase === "feedback" || this.phase === "intertrial") return false;
    this.startTrial(nowMs);
    return true;
  }

  private get currentTrial(): CargoSignalTrialPlanItem {
    const trial = this.plan[this.trialIndex];
    if (!trial) throw new Error("BrainPet cargo trial plan is exhausted.");
    return trial;
  }

  private startTrial(nowMs: number): void {
    this.phase = "flight";
    this.phaseStartedAt = nowMs;
    this.phaseEndsAt = nowMs + this.currentTrial.flightMs;
    this.trialPlannedAt = nowMs;
    this.currentStimulusId = `cargo-${this.stimulusCounter += 1}`;
    this.frame = this.createFrame(nowMs);
  }

  private enterPhase(phase: typeof this.phase, nowMs: number, durationMs: number): void {
    this.phase = phase;
    this.phaseStartedAt = nowMs;
    this.phaseEndsAt = nowMs + Math.max(0, durationMs);
  }

  private createScene(nowMs: number): StageScene {
    const flightProgress = this.phase === "flight" ? Math.min(1, Math.max(0, (nowMs - this.phaseStartedAt) / Math.max(1, this.currentTrial.flightMs))) : 1;
    const showCargo = this.phase === "flight";
    const cargoAsset = cargoAssetId(this.currentTrial.kind, this.currentTrial.cargoVariant);
    return validateStageScene({
      id: "cargo-toss",
      camera: { x: 0, y: 0, zoom: 1 },
      reactionInput: "primary",
      layers: [
        { id: "goal", z: 1, sprites: [{ id: "cargo-dock", assetId: "cargo-dock", x: 50, y: 72, frame: 0, ariaLabel: "补给箱" }] },
        { id: "cargo", z: 10, sprites: [] },
      ],
      particles: [],
      rigProjectiles: showCargo ? [{ id: this.currentStimulusId, assetId: cargoAsset, progress: flightProgress, arcHeightPx: this.currentTrial.arcHeightPx, curveOffsetPx: this.currentTrial.curveOffsetPx, spinTurns: this.currentTrial.spinTurns, ariaLabel: this.currentTrial.kind === "go" ? "蓝色补给" : "红色故障包" }] : [],
    });
  }

  private createTrialRecord(inputType: "primary" | "none", inputAtMs: number | null, correct: boolean): BrainPetTrialRecord {
    return {
      stimulusId: this.currentStimulusId,
      stimulusKind: this.currentTrial.kind,
      blockIndex: Math.min(3, Math.floor(this.trialIndex / 8) + 1) as 1 | 2 | 3,
      plannedAtMs: this.trialPlannedAt,
      presentedAtMs: this.trialPlannedAt,
      inputType,
      inputAtMs,
      correct,
      reactionTimeMs: inputAtMs === null ? null : Math.max(0, inputAtMs - this.trialPlannedAt),
    };
  }

  private finishDecision(trial: BrainPetTrialRecord, nowMs: number): void {
    this.trials.push(trial);
    const delta = computeBrainPetTrialScore(this.manifest, trial, this.parameters);
    this.score += delta;
    const correct = trial.correct;
    if (correct) {
      this.correct += 1;
      this.combo += 1;
    } else {
      if (trial.inputType === "none") this.missed += 1;
      else this.incorrect += 1;
      if (trial.stimulusKind === "no-go") this.falseAlarms += 1;
      this.combo = 0;
    }
    this.enterPhase("feedback", nowMs, this.numberParameter("feedbackMs", 220));
    this.frame = { ...this.createFrame(nowMs), feedback: correct ? "correct" : "incorrect", feedbackText: "score", feedbackScore: delta };
  }

  private createFrame(nowMs: number): BrainPetTaskFrame {
    const trialProgress = this.phase === "flight" ? Math.min(1, Math.max(0, (nowMs - this.phaseStartedAt) / Math.max(1, this.currentTrial.flightMs))) : 1;
    return {
      eyebrow: `第 ${this.level} 关 · ${this.trialIndex + 1}/${this.plan.length}`,
      title: this.currentTrial.kind === "go" ? "蓝色补给" : "红色故障包",
      instruction: this.currentTrial.kind === "go" ? "接住" : "放过",
      symbol: "",
      tone: this.currentTrial.kind === "go" ? "sky" : "rose",
      progress: Math.min(1, (this.trialIndex + trialProgress) / Math.max(1, this.plan.length)),
      score: Math.max(0, Math.round(this.score)),
      feedback: "neutral",
      combo: this.combo,
      scene: this.createScene(nowMs),
    };
  }
}

function cargoAssetId(kind: "go" | "no-go", variant: 0 | 1 | 2): string {
  const suffix = variant === 1 ? "-capsule" : variant === 2 ? "-orb" : "";
  return `cargo-${kind === "go" ? "go" : "no-go"}${suffix}`;
}

class PackRefreshTask extends BaseTask {
  readonly manifest = getBrainPetTaskManifest("pack-refresh");
  frame: BrainPetTaskFrame = emptyFrame();
  private slots: string[] = [];
  private choices: string[] = [];
  private dropped = "";
  private roundEndsAt = 0;
  private feedbackUntil = 0;
  private awaitingChoice = false;
  private roundCounter = 0;
  private roundPresentedAt = 0;
  private roundPlannedAt = 0;

  protected onStart(nowMs: number): void {
    const capacity = Math.round(this.numberParameter("capacity", 3));
    this.slots = shuffled(this.random, PACK_SYMBOLS).slice(0, capacity);
    this.awaitingChoice = false;
    this.roundEndsAt = nowMs + 1_800;
    this.frame = {
      eyebrow: `第 ${this.level} 关 · 规则测试`,
      title: `先记住行囊里的 ${capacity} 件物品`,
      instruction: "新物品进入后，找出刚被移出的那件",
      symbol: "B",
      slots: [...this.slots],
      tone: "mint",
      progress: this.progress(nowMs),
      score: 0,
      feedback: "neutral",
    };
  }

  input(input: BrainPetTaskInput): void {
    if (this.finished || !this.awaitingChoice || (input.type !== "primary" && input.type !== "secondary")) return;
    const selectedIndex = input.type === "primary" ? 0 : 1;
    const correct = this.choices[selectedIndex] === this.dropped;
    this.awaitingChoice = false;
    if (correct) {
      this.correct += 1;
      this.score += 140;
      this.combo += 1;
    } else {
      this.incorrect += 1;
      this.score -= 35;
      this.combo = 0;
    }
    this.feedbackUntil = input.atMs + 520;
    this.frame = { ...this.frame, feedback: correct ? "correct" : "incorrect", feedbackText: correct ? "更新正确！" : `刚移出的是 ${this.dropped}` };
    this.recordRound(input.type, input.atMs, correct);
  }

  tick(nowMs: number): void {
    if (this.finished) return;
    if (this.progress(nowMs) >= 1) {
      if (this.awaitingChoice) {
        this.missed += 1;
        this.score -= 35;
        this.recordRound("none", null, false);
      }
      this.finished = true;
      this.frame = { ...this.frame, progress: 1 };
      return;
    }
    if (nowMs >= this.roundEndsAt) {
      if (this.awaitingChoice) {
        this.missed += 1;
        this.score -= 35;
        this.recordRound("none", null, false);
      }
      this.nextRound(nowMs, this.roundEndsAt);
    }
    this.frame = { ...this.frame, progress: this.progress(nowMs), score: Math.max(0, Math.round(this.score)), feedback: nowMs < this.feedbackUntil ? this.frame.feedback : "neutral", feedbackText: nowMs < this.feedbackUntil ? this.frame.feedbackText : undefined };
  }

  private nextRound(nowMs: number, plannedAtMs = nowMs): void {
    const previousSlots = [...this.slots];
    this.dropped = this.slots.shift()!;
    const newItem = pick(this.random, PACK_SYMBOLS.filter((item) => !previousSlots.includes(item)));
    this.slots.push(newItem);
    // Both answers stay outside the updated set, so the player cannot solve the
    // trial by comparing candidates with what is currently visible. Exactly one
    // candidate belonged to the previous set: the item that was removed.
    const distractor = pick(this.random, PACK_SYMBOLS.filter((item) => !previousSlots.includes(item) && !this.slots.includes(item)));
    this.choices = this.random() > 0.5 ? [this.dropped, distractor] : [distractor, this.dropped];
    this.awaitingChoice = true;
    this.roundPresentedAt = nowMs;
    this.roundPlannedAt = plannedAtMs;
    this.roundCounter += 1;
    const blockIndex = this.blockIndex(nowMs);
    this.roundEndsAt = nowMs + Math.max(1_500, this.numberParameter("responseWindowMs", 3_300) - (blockIndex - 1) * this.numberParameter("blockStepMs", 140));
    this.frame = {
      eyebrow: `第 ${this.level} 关 · 区段 ${blockIndex}/3`,
      title: "新物品进入，哪件刚被移出？",
      instruction: "点击左 / 右答案，或按 ← / →",
      symbol: this.slots.at(-1)!,
      slots: [...this.slots],
      choices: [...this.choices],
      tone: "mint",
      progress: this.progress(nowMs),
      score: Math.max(0, Math.round(this.score)),
      feedback: "neutral",
      combo: this.combo,
    };
  }

  private recordRound(inputType: "primary" | "secondary" | "none", inputAtMs: number | null, correct: boolean): void {
    this.trials.push({
      stimulusId: `pack-${this.roundCounter}`,
      stimulusKind: this.choices[0] === this.dropped ? "continuous-update-left" : "continuous-update-right",
      blockIndex: this.blockIndex(this.roundPresentedAt),
      plannedAtMs: this.roundPlannedAt,
      presentedAtMs: this.roundPresentedAt,
      inputType,
      inputAtMs,
      correct,
      reactionTimeMs: inputAtMs === null ? null : Math.max(0, inputAtMs - this.roundPresentedAt),
    });
  }
}

class StageExerciserTask extends BaseTask {
  readonly manifest = getBrainPetTaskManifest("stage-exerciser");
  frame: BrainPetTaskFrame = emptyFrame();

  protected onStart(nowMs: number): void {
    this.frame = { eyebrow: "STAGE EXERCISER", title: "运行时链路测试", instruction: "输入、计时、动画、结算与模块替换", symbol: "B", tone: "gold", slots: ["IPC", "60FPS", "SEED"], progress: this.progress(nowMs), score: 0, feedback: "neutral" };
  }

  input(input: BrainPetTaskInput): void {
    if (input.type === "primary" || input.type === "secondary") {
      this.correct += 1;
      this.score += 10;
      this.trials.push({ stimulusId: `exercise-${this.correct}`, stimulusKind: `input-echo-${input.type}`, blockIndex: this.blockIndex(input.atMs), plannedAtMs: input.atMs, presentedAtMs: input.atMs, inputType: input.type, inputAtMs: input.atMs, correct: true, reactionTimeMs: 0 });
      this.frame = { ...this.frame, feedback: "correct", feedbackText: `INPUT ${this.correct} OK` };
    }
  }

  tick(nowMs: number): void {
    if (this.progress(nowMs) >= 1) this.finished = true;
    this.frame = { ...this.frame, progress: this.progress(nowMs), score: this.score };
  }
}

class FoundationProbeTask extends BaseTask {
  readonly manifest = getBrainPetTaskManifest("foundation-probe");
  frame: BrainPetTaskFrame = emptyFrame();

  protected onStart(nowMs: number): void {
    this.frame = this.createFrame(nowMs);
  }

  input(input: BrainPetTaskInput): void {
    if (this.finished || (input.type !== "primary" && input.type !== "secondary")) return;
    const expected = this.correct % 2 === 0 ? "primary" : "secondary";
    const correct = input.type === expected;
    this.trials.push({ stimulusId: `probe-${this.trials.length + 1}`, stimulusKind: expected === "primary" ? "probe-left" : "probe-right", blockIndex: this.blockIndex(input.atMs), plannedAtMs: input.atMs, presentedAtMs: input.atMs, inputType: input.type, inputAtMs: input.atMs, correct, reactionTimeMs: 0 });
    if (correct) { this.correct += 1; this.score += 10; } else { this.incorrect += 1; this.score -= 5; }
    this.frame = this.createFrame(input.atMs);
  }

  tick(nowMs: number): void {
    if (this.progress(nowMs) >= 1) this.finished = true;
    this.frame = this.createFrame(nowMs);
  }

  private createFrame(nowMs: number): BrainPetTaskFrame {
    const scene = validateStageScene({
      id: "foundation-probe",
      camera: { x: 0, y: 0, zoom: 1 },
      layers: [
        { id: "background", z: 0, sprites: [{ id: "label", assetId: "text", x: 50, y: 18, frame: 0, text: "SCENE CONTRACT" }] },
        { id: "targets", z: 10, sprites: [
          { id: "left", assetId: "probe-gem", x: 28, y: 58, frame: 0, text: "L", input: "primary" },
          { id: "right", assetId: "probe-gem", x: 72, y: 58, frame: 0, text: "R", input: "secondary" },
        ] },
      ],
      particles: [{ id: "pulse", x: 50, y: 58, lifetimeMs: 300 }],
    });
    return { eyebrow: "FOUNDATION PROBE", title: "异构场景模块", instruction: "点击左右目标，验证通用 scene/input 路径", symbol: "", tone: "gold", scene, progress: this.progress(nowMs), score: Math.max(0, this.score), feedback: "neutral" };
  }
}

function emptyFrame(): BrainPetTaskFrame {
  return { eyebrow: "BRAINPET", title: "准备中", instruction: "", symbol: "B", tone: "sky", progress: 0, score: 0 };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function shuffled<T>(random: () => number, values: readonly T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}
