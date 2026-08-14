import assert from "node:assert/strict";
import test from "node:test";

import { BRAINPET_STAGE_MAX_GAP_PX, createBrainPetInteractionRig, isBrainPetPointInsideRectangle, reanchorBrainPetInteractionRig, translateBrainPetStageInRig } from "../src/brainpet/interaction-rig.js";

const environment = {
  displayId: "primary",
  scaleFactor: 1.25,
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

test("interaction overlay contains the pet, playfield, and host-authored throw origin", () => {
  const rig = createBrainPetInteractionRig({
    rigId: "rig-1",
    petWindowId: 7,
    petBounds: { x: 1500, y: 820, width: 140, height: 140 },
    environment,
    atMs: 10,
  });

  assert.equal(contains(rig.overlayBoundsScreen, rig.petBoundsScreen), true);
  assert.equal(contains(rig.overlayBoundsScreen, rig.stageBoundsScreen), true);
  assert.deepEqual(rig.throwOriginOverlay, {
    x: rig.throwOriginScreen.x - rig.overlayBoundsScreen.x,
    y: rig.throwOriginScreen.y - rig.overlayBoundsScreen.y,
  });
  assert.equal(rig.stageBoundsScreen.width, 640);
  assert.equal(rig.stageBoundsScreen.height, 360);
});

test("dragging the playfield leaves the pet in place", () => {
  const initial = createBrainPetInteractionRig({
    rigId: "rig-2",
    petWindowId: 8,
    petBounds: { x: 800, y: 760, width: 140, height: 140 },
    environment,
  });
  const moved = translateBrainPetStageInRig(initial, { x: 260, y: -120 }, environment, { dragging: true });

  assert.deepEqual(moved.petBoundsScreen, initial.petBoundsScreen);
  assert.notDeepEqual(moved.stageBoundsScreen, initial.stageBoundsScreen);
  assert.equal(moved.dragging, true);
});

test("playfield translation clamps the game area while leaving the pet behind", () => {
  const initial = createBrainPetInteractionRig({
    rigId: "rig-3",
    petWindowId: 9,
    petBounds: { x: 800, y: 760, width: 140, height: 140 },
    environment,
  });
  const moved = translateBrainPetStageInRig(initial, { x: 10_000, y: 10_000 }, environment);

  assert.equal(moved.overlayBoundsScreen.x >= environment.workArea.x, true);
  assert.equal(moved.overlayBoundsScreen.y >= environment.workArea.y, true);
  assert.equal(moved.overlayBoundsScreen.x + moved.overlayBoundsScreen.width <= environment.workArea.x + environment.workArea.width, true);
  assert.equal(moved.overlayBoundsScreen.y + moved.overlayBoundsScreen.height <= environment.workArea.y + environment.workArea.height, true);
  assert.deepEqual(moved.petBoundsScreen, initial.petBoundsScreen);
});

test("pet-originated movement leaves the user-positioned playfield in place", () => {
  const initial = createBrainPetInteractionRig({
    rigId: "rig-4",
    petWindowId: 10,
    petBounds: { x: 820, y: 760, width: 140, height: 140 },
    environment,
  });
  const movedPet = { ...initial.petBoundsScreen, x: 620, y: 690 };
  const reanchored = reanchorBrainPetInteractionRig(initial, movedPet, environment, { dragging: true });

  assert.deepEqual(reanchored.stageBoundsScreen, initial.stageBoundsScreen);
  assert.equal(reanchored.petBoundsScreen.x, movedPet.x);
  assert.equal(reanchored.petBoundsScreen.y, movedPet.y);
});

test("the playfield leash prevents an effectively full-screen interaction overlay", () => {
  const initial = createBrainPetInteractionRig({
    rigId: "rig-5",
    petWindowId: 11,
    petBounds: { x: 1200, y: 760, width: 140, height: 140 },
    environment,
  });
  const moved = translateBrainPetStageInRig(initial, { x: -10_000, y: -10_000 }, environment);
  assert.equal(rectangleGap(moved.petBoundsScreen, moved.stageBoundsScreen) <= BRAINPET_STAGE_MAX_GAP_PX + 2, true);
  assert.equal(moved.overlayBoundsScreen.width < environment.workArea.width, true);
  assert.equal(moved.overlayBoundsScreen.height < environment.workArea.height, true);
});

test("host hit testing activates the full game stage before the renderer receives a click", () => {
  const stage = { x: 700, y: 300, width: 640, height: 360 };
  assert.equal(isBrainPetPointInsideRectangle({ x: 700, y: 300 }, stage), true);
  assert.equal(isBrainPetPointInsideRectangle({ x: 1339, y: 659 }, stage), true);
  assert.equal(isBrainPetPointInsideRectangle({ x: 1340, y: 660 }, stage), false);
  assert.equal(isBrainPetPointInsideRectangle({ x: 695, y: 295 }, stage, 6), true);
  assert.equal(isBrainPetPointInsideRectangle({ x: 693, y: 293 }, stage, 6), false);
});

function contains(outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function rectangleGap(left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }): number {
  const dx = Math.max(left.x - (right.x + right.width), right.x - (left.x + left.width), 0);
  const dy = Math.max(left.y - (right.y + right.height), right.y - (left.y + left.height), 0);
  return Math.hypot(dx, dy);
}
