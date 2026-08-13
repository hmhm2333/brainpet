import type { BrainPetTaskId, BrainPetTaskInput, BrainPetTaskManifest, BrainPetTaskResult, BrainPetTrialRecord } from "../../../brainpet/task-contract.js";
import { getBrainPetTaskManifest } from "../../../brainpet/task-registry.js";

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
  readonly progress: number;
  readonly score: number;
}

export interface BrainPetTaskModule {
  readonly manifest: BrainPetTaskManifest;
  readonly frame: BrainPetTaskFrame;
  readonly finished: boolean;
  start(seed: number, level: number, nowMs: number): void;
  input(input: BrainPetTaskInput): void;
  tick(nowMs: number): void;
  result(nowMs: number): BrainPetTaskResult;
}

const CARGO_SYMBOLS = ["◆", "●", "▲", "■", "✦", "⬟"] as const;
const PACK_SYMBOLS = ["⚙", "✦", "◆", "●", "▲", "■"] as const;

export function createTaskModule(taskId: BrainPetTaskId): BrainPetTaskModule {
  if (taskId === "cargo-signal") return new CargoSignalTask();
  if (taskId === "pack-refresh") return new PackRefreshTask();
  return new StageExerciserTask();
}

abstract class BaseTask implements BrainPetTaskModule {
  abstract readonly manifest: BrainPetTaskManifest;
  abstract frame: BrainPetTaskFrame;
  finished = false;
  protected seed = 1;
  protected level = 1;
  protected startedAt = 0;
  protected correct = 0;
  protected incorrect = 0;
  protected missed = 0;
  protected falseAlarms = 0;
  protected score = 0;
  protected trials: BrainPetTrialRecord[] = [];
  protected random: () => number = () => 0;

  start(seed: number, level: number, nowMs: number): void {
    this.seed = seed >>> 0 || 1;
    this.level = level;
    this.startedAt = nowMs;
    this.correct = 0;
    this.incorrect = 0;
    this.missed = 0;
    this.falseAlarms = 0;
    this.score = 0;
    this.trials = [];
    this.finished = false;
    this.random = seededRandom(this.seed);
    this.onStart(nowMs);
  }

  abstract input(input: BrainPetTaskInput): void;
  abstract tick(nowMs: number): void;
  protected abstract onStart(nowMs: number): void;

  result(nowMs: number): BrainPetTaskResult {
    return {
      taskId: this.manifest.id,
      seed: this.seed,
      score: Math.max(0, Math.round(this.score)),
      correct: this.correct,
      incorrect: this.incorrect,
      missed: this.missed,
      durationMs: Math.min(this.manifest.durationMs, Math.max(0, nowMs - this.startedAt)),
      completedAt: new Date().toISOString(),
      taskVersion: this.manifest.taskVersion,
      assetVersion: this.manifest.assetVersion,
      difficultyPolicyVersion: "brainpet-block-v1",
      scoreVersion: "brainpet-score-v1",
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
}

class CargoSignalTask extends BaseTask {
  readonly manifest = getBrainPetTaskManifest("cargo-signal");
  frame: BrainPetTaskFrame = emptyFrame();
  private isGo = true;
  private stimulusEndsAt = 0;
  private nextStimulusAt = 0;
  private answered = false;
  private feedbackUntil = 0;
  private stimulusCounter = 0;
  private stimulusPresentedAt = 0;
  private stimulusPlannedAt = 0;
  private currentStimulusId = "";

  protected onStart(nowMs: number): void {
    this.nextStimulus(nowMs);
  }

  input(input: BrainPetTaskInput): void {
    if (input.type !== "primary" || this.finished || this.answered || input.atMs > this.stimulusEndsAt) return;
    this.answered = true;
    if (this.isGo) this.mark(true, "装箱成功！", input.atMs);
    else {
      this.falseAlarms += 1;
      this.mark(false, "这个要放过", input.atMs);
    }
    this.recordTrial(input.type, input.atMs, this.isGo);
  }

  tick(nowMs: number): void {
    if (this.finished) return;
    if (this.progress(nowMs) >= 1) {
      if (!this.answered && this.isGo) {
        this.missed += 1;
        this.score -= 40;
        this.recordTrial("none", null, false);
      }
      this.finished = true;
      this.frame = { ...this.frame, progress: 1 };
      return;
    }
    if (nowMs >= this.stimulusEndsAt && !this.answered) {
      this.answered = true;
      if (this.isGo) {
        this.missed += 1;
        this.score -= 40;
        this.showFeedback(false, "错过货物", nowMs);
      } else this.mark(true, "判断漂亮！", nowMs);
      this.recordTrial("none", null, !this.isGo);
    }
    if (nowMs >= this.nextStimulusAt) this.nextStimulus(nowMs, this.nextStimulusAt);
    this.frame = { ...this.frame, progress: this.progress(nowMs), score: Math.max(0, Math.round(this.score)), feedback: nowMs < this.feedbackUntil ? this.frame.feedback : "neutral", feedbackText: nowMs < this.feedbackUntil ? this.frame.feedbackText : undefined };
  }

  private nextStimulus(nowMs: number, plannedAtMs = nowMs): void {
    this.isGo = this.random() > 0.28;
    this.answered = false;
    this.stimulusEndsAt = nowMs + Math.max(560, 980 - this.level * 35);
    this.nextStimulusAt = this.stimulusEndsAt + 260;
    this.stimulusPresentedAt = nowMs;
    this.stimulusPlannedAt = plannedAtMs;
    this.currentStimulusId = `cargo-${this.stimulusCounter += 1}`;
    const symbol = pick(this.random, CARGO_SYMBOLS);
    this.frame = {
      eyebrow: "信号装箱",
      title: this.isGo ? "蓝印货物" : "红印货物",
      instruction: this.isGo ? "点击 / 空格：装箱" : "不要操作：放过",
      symbol,
      tone: this.isGo ? "sky" : "rose",
      progress: this.progress(nowMs),
      score: Math.max(0, Math.round(this.score)),
      feedback: "neutral",
    };
  }

  private recordTrial(inputType: "primary" | "none", inputAtMs: number | null, correct: boolean): void {
    this.trials.push({
      stimulusId: this.currentStimulusId,
      stimulusKind: this.isGo ? "go" : "no-go",
      plannedAtMs: this.stimulusPlannedAt,
      presentedAtMs: this.stimulusPresentedAt,
      inputType,
      inputAtMs,
      correct,
      reactionTimeMs: inputAtMs === null ? null : Math.max(0, inputAtMs - this.stimulusPresentedAt),
    });
  }

  private mark(correct: boolean, text: string, nowMs: number): void {
    if (correct) {
      this.correct += 1;
      this.score += 100;
    } else {
      this.incorrect += 1;
      this.score -= 40;
    }
    this.showFeedback(correct, text, nowMs);
  }

  private showFeedback(correct: boolean, text: string, nowMs: number): void {
    this.feedbackUntil = nowMs + 420;
    this.frame = { ...this.frame, feedback: correct ? "correct" : "incorrect", feedbackText: text };
  }
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
    this.slots = shuffled(this.random, PACK_SYMBOLS).slice(0, 3);
    this.awaitingChoice = false;
    this.roundEndsAt = nowMs + 1_800;
    this.frame = {
      eyebrow: "第一关 · 规则测试",
      title: "先记住行囊里的 3 件物品",
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
    } else {
      this.incorrect += 1;
      this.score -= 35;
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
    this.dropped = this.slots.shift()!;
    const available = PACK_SYMBOLS.filter((item) => !this.slots.includes(item));
    this.slots.push(pick(this.random, available));
    const distractor = pick(this.random, PACK_SYMBOLS.filter((item) => item !== this.dropped));
    this.choices = this.random() > 0.5 ? [this.dropped, distractor] : [distractor, this.dropped];
    this.awaitingChoice = true;
    this.roundPresentedAt = nowMs;
    this.roundPlannedAt = plannedAtMs;
    this.roundCounter += 1;
    this.roundEndsAt = nowMs + Math.max(1_700, 3_200 - this.level * 80);
    this.frame = {
      eyebrow: "行囊更新",
      title: "新物品进入，哪件刚被移出？",
      instruction: "点击左 / 右答案，或按 ← / →",
      symbol: this.slots.at(-1)!,
      slots: [...this.slots],
      choices: [...this.choices],
      tone: "mint",
      progress: this.progress(nowMs),
      score: Math.max(0, Math.round(this.score)),
      feedback: "neutral",
    };
  }

  private recordRound(inputType: "primary" | "secondary" | "none", inputAtMs: number | null, correct: boolean): void {
    this.trials.push({
      stimulusId: `pack-${this.roundCounter}`,
      stimulusKind: "continuous-update",
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
      this.trials.push({ stimulusId: `exercise-${this.correct}`, stimulusKind: "input-echo", plannedAtMs: input.atMs, presentedAtMs: input.atMs, inputType: input.type, inputAtMs: input.atMs, correct: true, reactionTimeMs: 0 });
      this.frame = { ...this.frame, feedback: "correct", feedbackText: `INPUT ${this.correct} OK` };
    }
  }

  tick(nowMs: number): void {
    if (this.progress(nowMs) >= 1) this.finished = true;
    this.frame = { ...this.frame, progress: this.progress(nowMs), score: this.score };
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
