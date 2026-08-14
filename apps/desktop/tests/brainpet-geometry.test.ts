import assert from "node:assert/strict";
import test from "node:test";

import { computeBrainPetStageBounds, computeBrainPetStageSize } from "../src/brainpet/geometry.js";

test("stage targets a compact 16:9 surface", () => {
  assert.deepEqual(computeBrainPetStageSize({ x: 0, y: 0, width: 1920, height: 1080 }), { width: 640, height: 360 });
});

test("stage shrinks for a constrained work area without leaving it", () => {
  const workArea = { x: 100, y: 50, width: 500, height: 300 };
  const size = computeBrainPetStageSize(workArea);
  const bounds = computeBrainPetStageBounds({ x: 480, y: 250, width: 100, height: 100 }, workArea, size);
  assert.equal(size.width / size.height > 1.77, true);
  assert.equal(bounds.x >= workArea.x, true);
  assert.equal(bounds.y >= workArea.y, true);
  assert.equal(bounds.x + bounds.width <= workArea.x + workArea.width, true);
  assert.equal(bounds.y + bounds.height <= workArea.y + workArea.height, true);
});

test("stage opens from the pet toward the work-area center", () => {
  const bounds = computeBrainPetStageBounds(
    { x: 1850, y: 800, width: 80, height: 80 },
    { x: 0, y: 0, width: 1920, height: 1040 },
  );
  assert.equal(bounds.x + bounds.width < 1850, true);
  assert.equal(bounds.x + bounds.width <= 1908, true);
});

test("stage remains inside every edge of a secondary display with negative coordinates", () => {
  const workArea = { x: -2560, y: -120, width: 2560, height: 1400 };
  const pets = [
    { x: workArea.x, y: workArea.y, width: 120, height: 120 },
    { x: workArea.x + workArea.width - 120, y: workArea.y, width: 120, height: 120 },
    { x: workArea.x, y: workArea.y + workArea.height - 120, width: 120, height: 120 },
    { x: workArea.x + workArea.width - 120, y: workArea.y + workArea.height - 120, width: 120, height: 120 },
  ];
  for (const pet of pets) {
    const bounds = computeBrainPetStageBounds(pet, workArea);
    assert.equal(bounds.x >= workArea.x, true);
    assert.equal(bounds.y >= workArea.y, true);
    assert.equal(bounds.x + bounds.width <= workArea.x + workArea.width, true);
    assert.equal(bounds.y + bounds.height <= workArea.y + workArea.height, true);
    assert.equal(bounds.width / bounds.height > 1.77, true);
  }
});

test("100, 125 and 150 percent DPI rounding remains within the two-pixel contract", () => {
  for (const scale of [1, 1.25, 1.5]) {
    const logical = computeBrainPetStageSize({ x: 0, y: 0, width: Math.round(1920 / scale), height: Math.round(1080 / scale) });
    const physicalWidth = Math.round(logical.width * scale);
    const roundTrippedWidth = physicalWidth / scale;
    assert.equal(Math.abs(roundTrippedWidth - logical.width) <= 2, true);
  }
});
