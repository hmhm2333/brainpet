import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { isBrainPetAgentCompletion, parseBrainPetAgentActivity } from "../src/brainpet/agent-activity-policy.js";

test("BrainPet recognizes only valid agent activity payloads", () => {
  assert.deepEqual(parseBrainPetAgentActivity({ kind: "react", reaction: "success", surface: "agent" }), {
    kind: "react",
    reaction: "success",
    surface: "agent",
  });
  assert.equal(parseBrainPetAgentActivity({ kind: "react", reaction: 1, surface: "agent" }), null);
  assert.equal(parseBrainPetAgentActivity({ kind: "react", reaction: "success", surface: "unknown" }), null);
});

test("BrainPet completion policy ignores progress and failure reactions", () => {
  assert.equal(isBrainPetAgentCompletion({ kind: "react", reaction: "success", surface: "agent" }), true);
  assert.equal(isBrainPetAgentCompletion({ kind: "say", reaction: "celebrating", surface: "default" }), true);
  assert.equal(isBrainPetAgentCompletion({ kind: "react", reaction: "working", surface: "agent" }), false);
  assert.equal(isBrainPetAgentCompletion({ kind: "react", reaction: "error", surface: "agent" }), false);
});

test("Host observes completion without routing it through close or pause", () => {
  const host = readFileSync(resolve("src/brainpet/host.ts"), "utf8");
  assert.match(host, /subscribePluginEvent\("agent:activity", handleAgentActivity\)/);
  const handler = host.slice(host.indexOf("function handleAgentActivity"), host.indexOf("export function getBrainPetRuntimeSnapshot"));
  assert.match(handler, /agent-completed/);
  assert.doesNotMatch(handler, /closeBrainPetStage|sendPauseEvent|transition\(/);
});
