import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BrowserWindow } from "electron";

import { BrainPetInteractionRigController } from "../src/brainpet/interaction-rig-controller.js";

class FakeWindow extends EventEmitter {
  readonly id: number;
  readonly webContents = { send: (_channel: string, _payload: unknown) => undefined };
  private destroyed = false;
  private bounds: Electron.Rectangle;

  constructor(id: number, bounds: Electron.Rectangle) {
    super();
    this.id = id;
    this.bounds = { ...bounds };
  }

  isDestroyed(): boolean { return this.destroyed; }
  getBounds(): Electron.Rectangle { return { ...this.bounds }; }
  getContentBounds(): Electron.Rectangle { return { ...this.bounds }; }
  setBounds(bounds: Electron.Rectangle): void { this.bounds = { ...bounds }; }
  setContentBounds(bounds: Electron.Rectangle): void { this.bounds = { ...bounds }; }
  focus(): void {}
}

test("InteractionRigController owns rig geometry and releases its anchor on dispose", () => {
  const anchor = new FakeWindow(7, { x: 620, y: 400, width: 160, height: 160 });
  const stage = new FakeWindow(8, { x: 0, y: 0, width: 1, height: 1 });
  const locks: boolean[] = [];
  const events: string[] = [];
  const environment = { displayId: "display-1", scaleFactor: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const controller = new BrainPetInteractionRigController({
    getStageWindow: () => stage as unknown as BrowserWindow,
    closeStage: (reason) => events.push(`close:${reason}`),
    emitStageEvent: (event) => events.push(String(event.type)),
    now: () => 100,
    wallClock: () => 200,
    displayForBounds: () => environment,
    displayForPoint: () => environment,
    setPositionLocked: (_window, locked) => locks.push(locked),
  });

  const snapshot = controller.start(anchor as unknown as BrowserWindow);
  assert.equal(snapshot.petWindowId, 7);
  assert.equal(controller.anchorWindow, anchor as unknown as BrowserWindow);
  assert.deepEqual(locks, [true]);

  controller.beginStageDrag({ screenX: 700, screenY: 480 });
  controller.moveStageDrag({ screenX: 730, screenY: 500 });
  assert.equal(controller.snapshot?.dragging, true);
  assert.deepEqual(stage.getContentBounds(), controller.snapshot?.overlayBoundsScreen);
  assert.ok(events.includes("rig-drag-start"));

  controller.dispose();
  controller.dispose();
  assert.equal(controller.snapshot, null);
  assert.equal(controller.anchorWindow, null);
  assert.deepEqual(locks, [true, false]);
});
