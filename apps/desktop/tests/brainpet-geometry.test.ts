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

test("stage prefers the space above the pet and clamps horizontally", () => {
  const bounds = computeBrainPetStageBounds(
    { x: 1850, y: 800, width: 80, height: 80 },
    { x: 0, y: 0, width: 1920, height: 1040 },
  );
  assert.equal(bounds.y < 800, true);
  assert.equal(bounds.x + bounds.width <= 1908, true);
});
