import assert from "node:assert/strict";
import test from "node:test";

import { createIdleSpriteKeyframes, idleSpriteTimeline } from "../src/pet-animation-timing.js";

test("idle sprite holds its resting pose and completes blink frames as one short burst", () => {
  assert.equal(idleSpriteTimeline[0]?.frame, 0);
  assert.equal(idleSpriteTimeline[1]?.percent, 78);
  assert.equal(idleSpriteTimeline.at(-1)?.percent, 100);
  assert.deepEqual(idleSpriteTimeline.slice(2, -1).map((stop) => stop.frame), [1, 2, 3, 4, 5]);
  assert.match(createIdleSpriteKeyframes("pet-idle", 192), /94% \{ background-position: -768px/);
});

test("idle sprite keyframes reject malformed timelines", () => {
  assert.throws(() => createIdleSpriteKeyframes("bad name", 192));
  assert.throws(() => createIdleSpriteKeyframes("pet-idle", 0));
  assert.throws(() => createIdleSpriteKeyframes("pet-idle", 192, [{ percent: 10, frame: 0 }, { percent: 100, frame: 1 }]));
});
