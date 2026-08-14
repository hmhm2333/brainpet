import assert from "node:assert/strict";
import test from "node:test";

import { BRAINPET_RIG_DRAG_THRESHOLD_PX, hasBrainPetRigDragStarted, isBrainPetRigPointer } from "../src/brainpet/rig-drag-gesture.js";

test("six pixels or less remains a click and movement beyond six pixels becomes a rig drag", () => {
  const start = { screenX: 100, screenY: 100 };
  assert.equal(hasBrainPetRigDragStarted(start, { screenX: 106, screenY: 100 }), false);
  assert.equal(hasBrainPetRigDragStarted(start, { screenX: 100, screenY: 100 + BRAINPET_RIG_DRAG_THRESHOLD_PX + 1 }), true);
});

test("rig pointer validation rejects non-finite renderer coordinates", () => {
  assert.equal(isBrainPetRigPointer({ screenX: 1, screenY: 2 }), true);
  assert.equal(isBrainPetRigPointer({ screenX: Number.NaN, screenY: 2 }), false);
  assert.equal(isBrainPetRigPointer({ screenX: 1, screenY: "2" }), false);
});
