import type { BrowserWindow } from "electron";

import { debug } from "../logger.js";
import { createBrainPetInteractionRig, reanchorBrainPetInteractionRig, reflowBrainPetInteractionRig, setBrainPetInteractionRigDragging, translateBrainPetStageInRig, type BrainPetInteractionRigSnapshot, type BrainPetRigEnvironment } from "./interaction-rig.js";
import type { BrainPetRigPointer } from "./rig-drag-gesture.js";

export interface BrainPetInteractionRigControllerOptions {
  readonly getStageWindow: () => BrowserWindow | null;
  readonly closeStage: (reason: string) => void;
  readonly emitStageEvent: (event: Record<string, unknown>) => void;
  readonly now?: () => number;
  readonly wallClock?: () => number;
  readonly displayForBounds: (bounds: Electron.Rectangle) => BrainPetRigEnvironment;
  readonly displayForPoint: (point: BrainPetRigPointer) => BrainPetRigEnvironment;
  readonly setPositionLocked: (window: BrowserWindow, locked: boolean) => void;
}

export class BrainPetInteractionRigController {
  private anchor: BrowserWindow | null = null;
  private rig: BrainPetInteractionRigSnapshot | null = null;
  private dragTransaction: { readonly source: "pet" | "stage"; readonly initial: BrainPetInteractionRigSnapshot; readonly startPointer?: BrainPetRigPointer; readonly settleOnMovement: boolean } | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private geometryTimer: NodeJS.Timeout | null = null;
  private repositionTimer: NodeJS.Timeout | null = null;
  private applyingBounds = false;
  private removeAnchorListeners: (() => void) | null = null;
  private anchorSyncScheduled = false;
  private lastPetThrowAt = 0;
  private disposed = false;
  private readonly now: () => number;
  private readonly wallClock: () => number;
  private readonly displayForBounds: (bounds: Electron.Rectangle) => BrainPetRigEnvironment;
  private readonly displayForPoint: (point: BrainPetRigPointer) => BrainPetRigEnvironment;
  private readonly setPositionLocked: (window: BrowserWindow, locked: boolean) => void;

  constructor(private readonly options: BrainPetInteractionRigControllerOptions) {
    this.now = options.now ?? (() => performance.now());
    this.wallClock = options.wallClock ?? (() => Date.now());
    this.displayForBounds = options.displayForBounds;
    this.displayForPoint = options.displayForPoint;
    this.setPositionLocked = options.setPositionLocked;
  }

  get snapshot(): BrainPetInteractionRigSnapshot | null {
    return this.rig;
  }

  get anchorWindow(): BrowserWindow | null {
    return this.anchor;
  }

  start(anchor: BrowserWindow): BrainPetInteractionRigSnapshot {
    if (this.disposed) throw new Error("BrainPet InteractionRigController is disposed.");
    this.bindAnchor(anchor);
    this.rig = this.createRig(anchor);
    this.startRepositionTimer();
    return this.rig;
  }

  replaceAnchor(anchor: BrowserWindow): BrainPetInteractionRigSnapshot {
    this.bindAnchor(anchor);
    const next = this.createRig(anchor);
    this.apply(next, true, true);
    return next;
  }

  handlePetDragLifecycle(sourceWindow: BrowserWindow, phase: "start" | "end"): void {
    if (sourceWindow !== this.anchor) return;
    if (phase === "start") this.beginDrag("pet");
    else this.endDrag("pet");
  }

  beginStageDrag(startPointer: BrainPetRigPointer): void {
    this.beginDrag("stage", startPointer);
  }

  moveStageDrag(point: BrainPetRigPointer): void {
    const transaction = this.dragTransaction;
    if (!transaction || transaction.source !== "stage" || !transaction.startPointer) return;
    const next = translateBrainPetStageInRig(
      transaction.initial,
      { x: Math.round(point.screenX - transaction.startPointer.screenX), y: Math.round(point.screenY - transaction.startPointer.screenY) },
      this.displayForPoint(point),
      { dragging: true, sequence: (this.rig?.sequence ?? transaction.initial.sequence) + 1, atMs: this.now() },
    );
    this.apply(next, false);
  }

  endStageDrag(): void {
    this.endDrag("stage");
  }

  synchronizeFromPet(interruptUnexpectedMove = true): void {
    const anchor = this.anchor;
    const before = this.rig;
    if (!anchor || anchor.isDestroyed() || !before) return;
    const petBounds = anchor.getBounds();
    if (rectanglesEqual(petBounds, before.petBoundsScreen)) return;
    const startedUnexpectedMove = !this.dragTransaction && interruptUnexpectedMove;
    if (startedUnexpectedMove) this.beginDrag("pet", undefined, true);
    const current = this.rig ?? before;
    const next = reanchorBrainPetInteractionRig(current, petBounds, this.displayForBounds(petBounds), {
      dragging: Boolean(this.dragTransaction),
      sequence: current.sequence + 1,
      atMs: this.now(),
    });
    this.apply(next, false);
    if (this.dragTransaction?.source === "pet" && this.dragTransaction.settleOnMovement) this.endDrag("pet");
  }

  reflow(reason: "display-change" | "resume"): void {
    const anchor = this.anchor;
    const before = this.rig;
    if (!anchor || anchor.isDestroyed() || !before) return;
    this.sendHostEvent({ type: "rig-invalidated", reason, rig: before });
    this.clearSettleTimer();
    this.dragTransaction = null;
    this.beginDrag("pet", undefined, true);
    const current = this.rig ?? before;
    const petBounds = anchor.getBounds();
    const next = reflowBrainPetInteractionRig(current, petBounds, this.displayForBounds(petBounds), {
      dragging: true,
      sequence: current.sequence + 1,
      atMs: this.now(),
    });
    this.apply(next, true, true);
    this.endDrag("pet");
  }

  animatePetThrow(stimulusId: string): void {
    const now = this.now();
    if (now - this.lastPetThrowAt < 100) return;
    const anchor = this.anchor;
    const rig = this.rig;
    if (!anchor || anchor.isDestroyed() || !rig) return;
    this.lastPetThrowAt = now;
    const petCenterX = rig.petBoundsScreen.x + rig.petBoundsScreen.width / 2;
    const reactionCenterX = rig.reactionBoundsScreen.x + rig.reactionBoundsScreen.width / 2;
    anchor.webContents.send("openpets:brainpet-throw", { stimulusId, direction: reactionCenterX < petCenterX ? "left" : "right" });
  }

  disposeStage(): void {
    this.stopRepositionTimer();
    this.clearSettleTimer();
    this.clearGeometryTimer();
    this.dragTransaction = null;
    this.rig = null;
    this.unbindAnchor();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeStage();
  }

  private createRig(anchor: BrowserWindow): BrainPetInteractionRigSnapshot {
    const petBounds = anchor.getBounds();
    return createBrainPetInteractionRig({
      rigId: `brainpet-${anchor.id}-${this.wallClock()}`,
      petWindowId: anchor.id,
      petBounds,
      environment: this.displayForBounds(petBounds),
      atMs: this.now(),
    });
  }

  private bindAnchor(anchor: BrowserWindow): void {
    if (this.anchor === anchor && this.removeAnchorListeners) return;
    this.unbindAnchor();
    this.anchor = anchor;
    this.setPositionLocked(anchor, true);
    const handleMove = () => this.scheduleSynchronization();
    const handleClosed = () => this.options.closeStage("anchor-closed");
    anchor.on("move", handleMove);
    anchor.on("moved", handleMove);
    anchor.once("closed", handleClosed);
    this.removeAnchorListeners = () => {
      anchor.off("move", handleMove);
      anchor.off("moved", handleMove);
      anchor.off("closed", handleClosed);
      this.setPositionLocked(anchor, false);
    };
  }

  private unbindAnchor(): void {
    this.removeAnchorListeners?.();
    this.removeAnchorListeners = null;
    this.anchor = null;
    this.anchorSyncScheduled = false;
  }

  private beginDrag(source: "pet" | "stage", startPointer?: BrainPetRigPointer, settleOnMovement = false): void {
    if (!this.rig || this.dragTransaction) return;
    this.clearSettleTimer();
    const next = setBrainPetInteractionRigDragging(this.rig, true, this.rig.sequence + 1, this.now());
    this.dragTransaction = { source, initial: next, settleOnMovement, ...(startPointer ? { startPointer } : {}) };
    this.apply(next, false, true);
    this.sendHostEvent({ type: "rig-drag-start", source, rig: next });
    debug("brainpet.runtime", "interaction rig drag started", { source, rigId: next.rigId, sequence: next.sequence });
  }

  private endDrag(source: "pet" | "stage"): void {
    const transaction = this.dragTransaction;
    if (!transaction || transaction.source !== source) return;
    this.clearSettleTimer();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.synchronizeFromPet(false);
      if (!this.rig) return;
      const next = setBrainPetInteractionRigDragging(this.rig, false, this.rig.sequence + 1, this.now());
      this.dragTransaction = null;
      this.apply(next, false, true);
      const stage = this.options.getStageWindow();
      if (stage && !stage.isDestroyed()) stage.focus();
      this.sendHostEvent({ type: "rig-drag-end", source, rig: next });
      debug("brainpet.runtime", "interaction rig drag settled", { source, rigId: next.rigId, sequence: next.sequence });
    }, 150);
    this.settleTimer.unref?.();
  }

  private scheduleSynchronization(): void {
    if (this.applyingBounds || this.anchorSyncScheduled) return;
    this.anchorSyncScheduled = true;
    setTimeout(() => {
      this.anchorSyncScheduled = false;
      this.synchronizeFromPet();
    }, 0).unref?.();
  }

  private apply(next: BrainPetInteractionRigSnapshot, movePet: boolean, flushGeometry = false): void {
    this.rig = next;
    const anchor = this.anchor;
    const stage = this.options.getStageWindow();
    this.applyingBounds = true;
    try {
      if (movePet && anchor && !anchor.isDestroyed() && !rectanglesEqual(anchor.getBounds(), next.petBoundsScreen)) anchor.setBounds(next.petBoundsScreen, false);
      if (stage && !stage.isDestroyed() && !rectanglesEqual(stage.getContentBounds(), next.overlayBoundsScreen)) stage.setContentBounds(next.overlayBoundsScreen, false);
    } finally {
      this.applyingBounds = false;
    }
    this.scheduleGeometryEvent(flushGeometry);
  }

  private scheduleGeometryEvent(flush = false): void {
    if (flush) {
      this.clearGeometryTimer();
      this.emitGeometry();
      return;
    }
    if (this.geometryTimer) return;
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = null;
      this.emitGeometry();
    }, 34);
    this.geometryTimer.unref?.();
  }

  private emitGeometry(): void {
    if (this.rig) this.sendHostEvent({ type: "rig-geometry-changed", rig: this.rig });
  }

  private sendHostEvent(event: Record<string, unknown>): void {
    this.options.emitStageEvent(event);
  }

  private startRepositionTimer(): void {
    this.stopRepositionTimer();
    this.repositionTimer = setInterval(() => this.synchronizeFromPet(false), 1_000);
    this.repositionTimer.unref?.();
  }

  private stopRepositionTimer(): void {
    if (!this.repositionTimer) return;
    clearInterval(this.repositionTimer);
    this.repositionTimer = null;
  }

  private clearSettleTimer(): void {
    if (!this.settleTimer) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private clearGeometryTimer(): void {
    if (!this.geometryTimer) return;
    clearTimeout(this.geometryTimer);
    this.geometryTimer = null;
  }
}

function rectanglesEqual(left: Electron.Rectangle, right: Electron.Rectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
