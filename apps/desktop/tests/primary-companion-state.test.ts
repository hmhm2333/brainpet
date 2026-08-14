import assert from "node:assert/strict";
import test from "node:test";

import { normalizePrimaryCompanionFollowMode, shouldShowPrimaryCompanionForAgentEvent } from "../src/app-state-core.js";

test("primary companion follows Agent events by default and supports a persistent pause", () => {
  assert.equal(normalizePrimaryCompanionFollowMode(undefined), "follow");
  assert.equal(normalizePrimaryCompanionFollowMode("follow"), "follow");
  assert.equal(normalizePrimaryCompanionFollowMode("paused"), "paused");
  assert.equal(normalizePrimaryCompanionFollowMode("unknown"), "follow");
  assert.equal(shouldShowPrimaryCompanionForAgentEvent(false, "follow"), true);
  assert.equal(shouldShowPrimaryCompanionForAgentEvent(false, "paused"), false);
  assert.equal(shouldShowPrimaryCompanionForAgentEvent(true, "follow"), false);
});
