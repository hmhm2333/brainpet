import type { BrainPetTaskId, BrainPetTaskResult, BrainPetTaskSessionConfig } from "../../../brainpet/task-contract";
import type { BrainPetInteractionRigSnapshot } from "../../../brainpet/interaction-rig";

interface BrainPetStageBootstrap {
  readonly apiVersion: 1;
  readonly mode: "stage-exerciser" | "training";
  readonly suggestedSeed: number;
  readonly session: BrainPetTaskSessionConfig;
  readonly availableTasks: readonly BrainPetTaskId[];
  readonly lastResult: BrainPetTaskResult | null;
  readonly highScores: Partial<Record<BrainPetTaskId, number>>;
  readonly levelHighScore: number;
  readonly todayCompleted: number;
  readonly petSpriteUrl: string | null;
  readonly rig: BrainPetInteractionRigSnapshot;
}

interface BrainPetBridge {
  getBootstrap(): Promise<BrainPetStageBootstrap>;
  nextSession(taskId: BrainPetTaskId, level: number): Promise<BrainPetTaskSessionConfig>;
  ready(): void;
  report(event:
    | { readonly type: "session-started"; readonly session: BrainPetTaskSessionConfig }
    | { readonly type: "pause-requested" }
    | { readonly type: "resume-requested" }
    | { readonly type: "session-finished"; readonly result: BrainPetTaskResult }
    | { readonly type: "settled" }
  ): void;
  setInteractive(interactive: boolean): void;
  animatePetThrow(stimulusId: string): void;
  beginRigDrag(point: { readonly screenX: number; readonly screenY: number }): void;
  moveRigDrag(point: { readonly screenX: number; readonly screenY: number }): void;
  endRigDrag(): void;
  close(): void;
  onHostEvent(listener: (event:
    | { readonly type: "pause" | "resume"; readonly reason: "lock-screen" | "suspend" }
    | { readonly type: "agent-completed"; readonly surface: "default" | "agent" }
    | { readonly type: "session-outcome"; readonly passed: boolean; readonly previousLevel: number; readonly nextLevel: number; readonly accuracy: number; readonly isNewLevelBest: boolean; readonly todayCompleted: number }
    | { readonly type: "rig-geometry-changed"; readonly rig: BrainPetInteractionRigSnapshot }
    | { readonly type: "rig-drag-start" | "rig-drag-end"; readonly source: "pet" | "stage"; readonly rig: BrainPetInteractionRigSnapshot }
    | { readonly type: "rig-invalidated"; readonly reason: "display-change" | "resume"; readonly rig: BrainPetInteractionRigSnapshot }
  ) => void): () => void;
}

declare global {
  interface Window {
    readonly brainPet: BrainPetBridge;
  }
}

export {};
