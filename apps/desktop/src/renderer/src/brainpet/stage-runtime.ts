import type { BrainPetResultQuality } from "../../../brainpet/task-contract.js";

export interface BrainPetStageSettings {
  readonly soundEnabled: boolean;
  readonly reducedMotion: boolean;
  readonly highContrast: boolean;
}

export const DEFAULT_STAGE_SETTINGS: BrainPetStageSettings = {
  soundEnabled: true,
  reducedMotion: false,
  highContrast: false,
};

export class LogicalSessionClock {
  private pausedAt: number | null = null;
  private pausedTotal = 0;

  reset(): void {
    this.pausedAt = null;
    this.pausedTotal = 0;
  }

  pause(nowMs: number): boolean {
    if (this.pausedAt !== null) return false;
    this.pausedAt = nowMs;
    return true;
  }

  resume(nowMs: number): boolean {
    if (this.pausedAt === null) return false;
    this.pausedTotal += Math.max(0, nowMs - this.pausedAt);
    this.pausedAt = null;
    return true;
  }

  now(nowMs: number): number {
    return (this.pausedAt ?? nowMs) - this.pausedTotal;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  pausedDuration(nowMs: number): number {
    return this.pausedTotal + (this.pausedAt === null ? 0 : Math.max(0, nowMs - this.pausedAt));
  }
}

export class StageQualityMonitor {
  private previousFrameAt: number | null = null;
  private droppedFrames = 0;
  private longFrames = 0;
  private maximumFrameMs = 0;
  private focusLosses = 0;
  private renderedFrames = 0;
  private timedFrames = 0;
  private sampledDurationMs = 0;

  frame(nowMs: number): void {
    this.renderedFrames += 1;
    if (this.previousFrameAt !== null) {
      const elapsed = Math.max(0, nowMs - this.previousFrameAt);
      this.timedFrames += 1;
      this.sampledDurationMs += elapsed;
      this.maximumFrameMs = Math.max(this.maximumFrameMs, elapsed);
      // V1 explicitly supports a 30 fps low-performance floor. Do not classify
      // ordinary 30 fps cadence or minor scheduler jitter as lost frames.
      if (elapsed > 40) this.droppedFrames += Math.max(1, Math.round(elapsed / (1000 / 30)) - 1);
      if (elapsed > 120) this.longFrames += 1;
    }
    this.previousFrameAt = nowMs;
  }

  focusLost(): void {
    this.focusLosses += 1;
  }

  resetFrameAnchor(): void {
    this.previousFrameAt = null;
  }

  snapshot(pausedMs: number): BrainPetResultQuality {
    const flags: string[] = [];
    const effectiveFps = this.sampledDurationMs > 0 ? this.timedFrames * 1_000 / this.sampledDurationMs : 60;
    if (this.focusLosses > 0) flags.push("focus-lost");
    if (this.longFrames > 0) flags.push("long-frame");
    // Absolute drop counts scale with session length. Invalidate only when the
    // effective cadence falls below the declared 30 fps floor for a sustained
    // sample, while still reporting isolated long frames as diagnostics.
    if (this.renderedFrames >= 120 && effectiveFps < 29) flags.push("excessive-frame-loss");
    return {
      valid: !flags.includes("excessive-frame-loss"),
      focusLossCount: this.focusLosses,
      pausedMs: Math.max(0, Math.round(pausedMs)),
      droppedFrameCount: this.droppedFrames,
      longFrameCount: this.longFrames,
      maxFrameMs: Math.round(this.maximumFrameMs * 100) / 100,
      flags,
    };
  }
}

export function loadStageSettings(storage: Pick<Storage, "getItem">): BrainPetStageSettings {
  try {
    const value = JSON.parse(storage.getItem("brainpet-stage-settings-v1") ?? "null") as Partial<BrainPetStageSettings> | null;
    return {
      soundEnabled: value?.soundEnabled !== false,
      reducedMotion: value?.reducedMotion === true,
      highContrast: value?.highContrast === true,
    };
  } catch {
    return DEFAULT_STAGE_SETTINGS;
  }
}

export function saveStageSettings(storage: Pick<Storage, "setItem">, settings: BrainPetStageSettings): void {
  storage.setItem("brainpet-stage-settings-v1", JSON.stringify(settings));
}
