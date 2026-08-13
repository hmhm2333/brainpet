import type { BrainPetTaskId, BrainPetTaskResult, BrainPetTaskSessionConfig } from "../../../brainpet/task-contract";

interface BrainPetStageBootstrap {
  readonly apiVersion: 1;
  readonly mode: "stage-exerciser" | "training";
  readonly suggestedSeed: number;
  readonly availableTasks: readonly BrainPetTaskId[];
  readonly lastResult: BrainPetTaskResult | null;
  readonly highScores: Partial<Record<BrainPetTaskId, number>>;
}

interface BrainPetBridge {
  getBootstrap(): Promise<BrainPetStageBootstrap>;
  ready(): void;
  report(event:
    | { readonly type: "session-started"; readonly session: BrainPetTaskSessionConfig }
    | { readonly type: "pause-requested" }
    | { readonly type: "resume-requested" }
    | { readonly type: "session-finished"; readonly result: BrainPetTaskResult }
    | { readonly type: "settled" }
  ): void;
  close(): void;
  onHostEvent(listener: (event:
    | { readonly type: "pause" | "resume"; readonly reason: "lock-screen" | "suspend" }
    | { readonly type: "agent-completed"; readonly surface: "default" | "agent" }
  ) => void): () => void;
}

declare global {
  interface Window {
    readonly brainPet: BrainPetBridge;
  }
}

export {};
