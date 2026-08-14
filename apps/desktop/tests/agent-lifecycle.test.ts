import assert from "node:assert/strict";
import test from "node:test";

import { applyAgentLifecycleEvent, deriveAgentLifecyclePresentation, pruneStaleAgentLifecycleEntries, type AgentLifecycleEntry, type AgentLifecycleEvent } from "../src/agent-lifecycle.js";

const event = (overrides: Partial<AgentLifecycleEvent> = {}): AgentLifecycleEvent => ({
  schemaVersion: 1,
  agent: "codex",
  sessionId: "session-a",
  turnId: "turn-a",
  state: "working",
  occurredAt: 100,
  capabilities: ["observeLifecycle"],
  ...overrides,
});

test("one completed Codex turn cannot hide another active task", () => {
  let entries = new Map<string, AgentLifecycleEntry>();
  entries = applyAgentLifecycleEvent(entries, event());
  entries = applyAgentLifecycleEvent(entries, event({ sessionId: "session-b", turnId: "turn-b", occurredAt: 110 }));
  entries = applyAgentLifecycleEvent(entries, event({ state: "ready", occurredAt: 120 }));
  assert.deepEqual(deriveAgentLifecyclePresentation(entries, event({ state: "ready", occurredAt: 120 })), {
    state: "working",
    reaction: "working",
    sticky: true,
    activeCount: 1,
  });
});

test("waiting takes priority and completion becomes a brief ready state", () => {
  let entries = applyAgentLifecycleEvent(new Map<string, AgentLifecycleEntry>(), event());
  entries = applyAgentLifecycleEvent(entries, event({ sessionId: "session-b", state: "waiting", occurredAt: 110 }));
  assert.equal(deriveAgentLifecyclePresentation(entries).state, "waiting");
  entries = applyAgentLifecycleEvent(entries, event({ sessionId: "session-b", state: "ready", occurredAt: 120 }));
  entries = applyAgentLifecycleEvent(entries, event({ state: "ready", occurredAt: 130 }));
  assert.deepEqual(deriveAgentLifecyclePresentation(entries, event({ state: "ready", occurredAt: 130 })), {
    state: "ready",
    reaction: "success",
    sticky: false,
    activeCount: 0,
  });
});

test("late asynchronous tool events cannot revive a completed turn", () => {
  let entries = applyAgentLifecycleEvent(new Map<string, AgentLifecycleEntry>(), event({ state: "ready", occurredAt: 200 }));
  entries = applyAgentLifecycleEvent(entries, event({ state: "working", occurredAt: 250 }));
  assert.equal(entries.get("codex\u0000session-a")?.state, "ready");
  entries = applyAgentLifecycleEvent(entries, event({ turnId: "turn-b", state: "working", occurredAt: 260 }));
  assert.equal(entries.get("codex\u0000session-a")?.state, "working", "a new turn must still start normally");
});

test("idle and stale-session cleanup remove abandoned activity", () => {
  let entries = applyAgentLifecycleEvent(new Map<string, AgentLifecycleEntry>(), event());
  assert.equal(pruneStaleAgentLifecycleEntries(entries, 1_101, 1_000).size, 0);
  entries = applyAgentLifecycleEvent(entries, event({ state: "idle", occurredAt: 200 }));
  assert.equal(entries.size, 0);
});
