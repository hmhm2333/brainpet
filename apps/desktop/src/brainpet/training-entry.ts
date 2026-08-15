import type { BrowserWindow } from "electron";

export type BrainPetTrainingRequestHandler = (sourceWindow: BrowserWindow) => void;

export interface BrainPetTrainingEntryOptions {
  readonly register: (handler: BrainPetTrainingRequestHandler | null) => void;
  readonly open: (sourceWindow: BrowserWindow) => void;
  readonly close: (reason: string) => void;
  readonly isOpen: () => boolean;
}

export class BrainPetTrainingEntry {
  private started = false;
  private readonly handleRequest = (sourceWindow: BrowserWindow): void => {
    if (!this.started) return;
    if (this.options.isOpen()) this.options.close("built-in-training-entry");
    else this.options.open(sourceWindow);
  };

  constructor(private readonly options: BrainPetTrainingEntryOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.register(this.handleRequest);
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;
    this.options.register(null);
  }
}
