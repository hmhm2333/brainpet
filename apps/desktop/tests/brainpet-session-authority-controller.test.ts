import assert from "node:assert/strict";
import test from "node:test";

import { createBrainPetInteractionRig } from "../src/brainpet/interaction-rig.js";
import { BrainPetSessionAuthority } from "../src/brainpet/session-authority.js";

const rig = createBrainPetInteractionRig({
  rigId: "authority-test",
  petWindowId: 7,
  petBounds: { x: 100, y: 300, width: 344, height: 424 },
  environment: { displayId: "primary", scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
  atMs: 1,
});

test("SessionAuthority owns issuance and runtime lifecycle independently", async () => {
  let monotonic = 10;
  const authority = new BrainPetSessionAuthority({
    now: () => ++monotonic,
    wallClock: () => Date.UTC(2026, 7, 16),
    processId: 42,
    emitStageEvent() {},
    emitAccessoryFeedback() {},
    applyPetReaction() {},
  });

  authority.beginOpen();
  const bootstrap = authority.createBootstrap(rig, null);
  assert.equal(authority.phase, "opening");
  assert.equal(bootstrap.apiVersion, 1);
  assert.equal(bootstrap.rig.rigId, rig.rigId);

  authority.stageReady();
  authority.handleStageEvent({ type: "session-started", session: bootstrap.session });
  assert.equal(authority.phase, "running");

  authority.handleStageEvent({ type: "session-started", session: { ...bootstrap.session, seed: bootstrap.session.seed + 1 } });
  assert.equal(authority.phase, "running", "a renderer cannot replace the Host-issued session");

  authority.beginClose();
  assert.equal(authority.phase, "closing");
  authority.stageClosed();
  assert.equal(authority.phase, "idle");

  await authority.dispose();
  await authority.dispose();
  assert.throws(() => authority.createBootstrap(rig, null), /disposed/);
});
