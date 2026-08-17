import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BrowserWindow } from "electron";

import type { BrainPetInteractionRigSnapshot } from "../src/brainpet/interaction-rig.js";
import type { BrainPetInteractionRigController } from "../src/brainpet/interaction-rig-controller.js";
import type { BrainPetSessionAuthority } from "../src/brainpet/session-authority.js";
import { BrainPetStageWindowController } from "../src/brainpet/stage-window-controller.js";

class FakeSession extends EventEmitter {
  permissionHandlerInstalled = false;
  cacheClears = 0;
  setPermissionRequestHandler(): void { this.permissionHandlerInstalled = true; }
  async clearCache(): Promise<void> { this.cacheClears += 1; }
}

class FakeWebContents extends EventEmitter {
  readonly session = new FakeSession();
  readonly sent: Array<[string, unknown]> = [];
  private destroyed = false;
  send(channel: string, payload: unknown): void { this.sent.push([channel, payload]); }
  isDestroyed(): boolean { return this.destroyed; }
  setWindowOpenHandler(): void {}
}

class FakeWindow extends EventEmitter {
  readonly id: number;
  readonly webContents = new FakeWebContents();
  readonly ignoredMouse: boolean[] = [];
  private destroyed = false;
  private bounds: Electron.Rectangle;

  constructor(id: number, bounds: Electron.Rectangle) {
    super();
    this.id = id;
    this.bounds = { ...bounds };
  }

  isDestroyed(): boolean { return this.destroyed; }
  isMinimized(): boolean { return false; }
  restore(): void {}
  show(): void {}
  focus(): void {}
  setIgnoreMouseEvents(ignore: boolean): void { this.ignoredMouse.push(ignore); }
  setMenu(): void {}
  setAlwaysOnTop(): void {}
  getBounds(): Electron.Rectangle { return { ...this.bounds }; }
  setBounds(bounds: Electron.Rectangle): void { this.bounds = { ...bounds }; }
  getContentBounds(): Electron.Rectangle { return { ...this.bounds }; }
  setContentBounds(bounds: Electron.Rectangle): void { this.bounds = { ...bounds }; }
  loadFile(): Promise<void> { return Promise.resolve(); }
  loadURL(): Promise<void> { return Promise.resolve(); }
  close(): void { this.destroyed = true; this.emit("closed"); }
  destroy(): void { this.close(); }
}

test("StageWindowController owns secure stage lifecycle, sender identity, and disposal", async () => {
  const rig: BrainPetInteractionRigSnapshot = {
    apiVersion: 1,
    rigId: "rig-test",
    petWindowId: 1,
    displayId: "display-1",
    scaleFactor: 1,
    overlayBoundsScreen: { x: 300, y: 200, width: 640, height: 480 },
    petBoundsScreen: { x: 620, y: 400, width: 160, height: 160 },
    stageBoundsScreen: { x: 300, y: 200, width: 640, height: 320 },
    reactionBoundsScreen: { x: 300, y: 520, width: 640, height: 160 },
    throwOriginScreen: { x: 700, y: 480 },
    throwOriginOverlay: { x: 400, y: 280 },
    dragging: false,
    sequence: 1,
    atMs: 1,
  };
  const lifecycle: string[] = [];
  const anchor = new FakeWindow(1, rig.petBoundsScreen);
  const stage = new FakeWindow(2, rig.overlayBoundsScreen);
  const authority = {
    beginOpen: () => lifecycle.push("begin-open"),
    beginClose: () => lifecycle.push("begin-close"),
    stageClosed: () => lifecycle.push("stage-closed"),
  } as unknown as BrainPetSessionAuthority;
  const rigController = {
    anchorWindow: anchor as unknown as BrowserWindow,
    snapshot: rig,
    start: () => { lifecycle.push("rig-start"); return rig; },
    replaceAnchor: () => rig,
    synchronizeFromPet: () => lifecycle.push("rig-sync"),
    disposeStage: () => lifecycle.push("rig-dispose"),
  } as unknown as BrainPetInteractionRigController;
  const controller = new BrainPetStageWindowController({
    authority,
    rigController,
    resolveDefaultAnchor: () => anchor as unknown as BrowserWindow,
    createWindow: () => stage as unknown as BrowserWindow,
    getAppPath: () => "C:\\brainpet-test",
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    onClosed: () => { lifecycle.push("recycle-pet-renderer"); },
  });

  controller.open();
  assert.equal(controller.window, stage as unknown as BrowserWindow);
  assert.equal(controller.isOpen, true);
  assert.equal(stage.webContents.session.permissionHandlerInstalled, true);
  assert.equal(controller.isSender({ sender: stage.webContents as never }), true);
  assert.throws(() => controller.assertSender({ sender: anchor.webContents as never } as never), /not the active stage/);
  assert.deepEqual(lifecycle.slice(0, 2), ["begin-open", "rig-start"]);

  controller.setRendererInteractive(true);
  assert.equal(stage.ignoredMouse.at(-1), false);
  controller.sendHostEvent({ type: "test-event" });
  assert.deepEqual(stage.webContents.sent.at(-1), ["brainpet:host-event", { type: "test-event" }]);

  controller.close("test-close");
  await Promise.resolve();
  assert.equal(controller.isOpen, false);
  assert.deepEqual(lifecycle.slice(-4), ["begin-close", "rig-dispose", "stage-closed", "recycle-pet-renderer"]);
  assert.equal(stage.webContents.session.cacheClears, 0, "warm stage assets stay cached between training sessions");

  controller.dispose();
  await Promise.resolve();
  assert.equal(stage.webContents.session.cacheClears, 1, "stage cache is released when the Host is disposed");
  controller.dispose();

  const shutdownStage = new FakeWindow(3, rig.overlayBoundsScreen);
  const shutdownEvents: string[] = [];
  const shutdownController = new BrainPetStageWindowController({
    authority,
    rigController,
    resolveDefaultAnchor: () => anchor as unknown as BrowserWindow,
    createWindow: () => shutdownStage as unknown as BrowserWindow,
    getAppPath: () => "C:\\brainpet-test",
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    onClosed: () => { shutdownEvents.push("recycle"); },
  });
  shutdownController.open();
  shutdownController.dispose();
  assert.deepEqual(shutdownEvents, [], "app shutdown must not recreate the pet renderer");
});

test("StageWindowController rolls back synchronous window creation failure and can reopen", () => {
  const rig: BrainPetInteractionRigSnapshot = {
    apiVersion: 1,
    rigId: "rig-failure",
    petWindowId: 11,
    displayId: "display-1",
    scaleFactor: 1,
    overlayBoundsScreen: { x: 0, y: 0, width: 640, height: 480 },
    petBoundsScreen: { x: 100, y: 100, width: 160, height: 160 },
    stageBoundsScreen: { x: 0, y: 0, width: 640, height: 320 },
    reactionBoundsScreen: { x: 0, y: 320, width: 640, height: 160 },
    throwOriginScreen: { x: 180, y: 180 },
    throwOriginOverlay: { x: 180, y: 180 },
    dragging: false,
    sequence: 1,
    atMs: 1,
  };
  const lifecycle: string[] = [];
  const anchor = new FakeWindow(11, rig.petBoundsScreen);
  const recovered = new FakeWindow(12, rig.overlayBoundsScreen);
  let attempts = 0;
  const controller = new BrainPetStageWindowController({
    authority: {
      beginOpen: () => lifecycle.push("begin-open"),
      beginClose: () => lifecycle.push("begin-close"),
      stageClosed: () => lifecycle.push("stage-closed"),
    } as unknown as BrainPetSessionAuthority,
    rigController: {
      anchorWindow: anchor as unknown as BrowserWindow,
      snapshot: rig,
      start: () => { lifecycle.push("rig-start"); return rig; },
      synchronizeFromPet: () => undefined,
      disposeStage: () => lifecycle.push("rig-dispose"),
    } as unknown as BrainPetInteractionRigController,
    resolveDefaultAnchor: () => anchor as unknown as BrowserWindow,
    createWindow: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("window-create-failed");
      return recovered as unknown as BrowserWindow;
    },
    getAppPath: () => "C:\\brainpet-test",
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  });

  assert.doesNotThrow(() => controller.open());
  assert.equal(controller.isOpen, false);
  assert.deepEqual(lifecycle, ["begin-open", "rig-start", "rig-dispose", "stage-closed"]);

  controller.open();
  assert.equal(controller.window, recovered as unknown as BrowserWindow);
  assert.equal(controller.isOpen, true);
  controller.close("recovered");
});

test("StageWindowController rolls back initialization and synchronous load failures", () => {
  const rig: BrainPetInteractionRigSnapshot = {
    apiVersion: 1,
    rigId: "rig-setup-failure",
    petWindowId: 21,
    displayId: "display-1",
    scaleFactor: 1,
    overlayBoundsScreen: { x: 0, y: 0, width: 640, height: 480 },
    petBoundsScreen: { x: 100, y: 100, width: 160, height: 160 },
    stageBoundsScreen: { x: 0, y: 0, width: 640, height: 320 },
    reactionBoundsScreen: { x: 0, y: 320, width: 640, height: 160 },
    throwOriginScreen: { x: 180, y: 180 },
    throwOriginOverlay: { x: 180, y: 180 },
    dragging: false,
    sequence: 1,
    atMs: 1,
  };

  for (const failure of ["initialize", "load"] as const) {
    const lifecycle: string[] = [];
    const anchor = new FakeWindow(21, rig.petBoundsScreen);
    const stage = new FakeWindow(failure === "initialize" ? 22 : 23, rig.overlayBoundsScreen);
    if (failure === "initialize") stage.setMenu = () => { throw new Error("set-menu-failed"); };
    else stage.loadFile = () => { throw new Error("load-file-failed"); };
    const controller = new BrainPetStageWindowController({
      authority: {
        beginOpen: () => lifecycle.push("begin-open"),
        beginClose: () => lifecycle.push("begin-close"),
        stageClosed: () => lifecycle.push("stage-closed"),
      } as unknown as BrainPetSessionAuthority,
      rigController: {
        anchorWindow: anchor as unknown as BrowserWindow,
        snapshot: rig,
        start: () => { lifecycle.push("rig-start"); return rig; },
        synchronizeFromPet: () => undefined,
        disposeStage: () => lifecycle.push("rig-dispose"),
      } as unknown as BrainPetInteractionRigController,
      resolveDefaultAnchor: () => anchor as unknown as BrowserWindow,
      createWindow: () => stage as unknown as BrowserWindow,
      getAppPath: () => "C:\\brainpet-test",
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    });

    assert.doesNotThrow(() => controller.open(), failure);
    assert.equal(controller.isOpen, false, failure);
    assert.equal(stage.isDestroyed(), true, failure);
    assert.deepEqual(lifecycle, ["begin-open", "rig-start", "rig-dispose", "stage-closed"], failure);
    assert.deepEqual(anchor.webContents.sent, [
      ["openpets:brainpet-stage-state", { open: true }],
      ["openpets:brainpet-stage-state", { open: false }],
    ], failure);
  }
});
