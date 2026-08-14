import assert from "node:assert/strict";
import test from "node:test";

import { deriveAgentCompanionActivitySummary, mapAgentLifecycleToCompanionStatus } from "../src/agent-companion-activity.js";
import type { AgentLifecycleEntry } from "../src/agent-lifecycle.js";

function entry(overrides: Partial<AgentLifecycleEntry> = {}): AgentLifecycleEntry {
  return {
    schemaVersion: 1,
    agent: "codex",
    sessionId: "session-a",
    turnId: "turn-a",
    state: "working",
    occurredAt: 100,
    capabilities: ["observeLifecycle"],
    ...overrides,
  };
}

test("lifecycle states map to the five Primary Companion statuses", () => {
  assert.equal(mapAgentLifecycleToCompanionStatus("working"), "working");
  assert.equal(mapAgentLifecycleToCompanionStatus("waiting"), "waiting");
  assert.equal(mapAgentLifecycleToCompanionStatus("ready"), "review");
  assert.equal(mapAgentLifecycleToCompanionStatus("blocked"), "failed");
  assert.equal(mapAgentLifecycleToCompanionStatus("idle"), "idle");
});

test("one main pet summarizes concurrent providers without exposing task content", () => {
  const entries = new Map<string, AgentLifecycleEntry>([
    ["codex-a", entry()],
    ["claude-b", entry({ agent: "claude", sessionId: "session-b", turnId: "turn-b", state: "waiting", occurredAt: 120 })],
    ["codex-c", entry({ sessionId: "session-c", turnId: "turn-c", state: "ready", occurredAt: 110 })],
  ]);
  const summary = deriveAgentCompanionActivitySummary(entries);

  assert.equal(summary.status, "waiting");
  assert.equal(summary.activeCount, 2);
  assert.equal(summary.unreadCount, 1);
  assert.equal(summary.totalCount, 3);
  assert.deepEqual(summary.items.map((item) => [item.provider, item.status]), [
    ["claude", "waiting"],
    ["codex", "review"],
    ["codex", "working"],
  ]);
  assert.deepEqual(Object.keys(summary.items[0]).sort(), ["capabilities", "occurredAt", "provider", "sessionId", "status", "turnId", "unread"]);
});

test("activity storage is bounded while counters still cover every current session", () => {
  const entries = new Map<string, AgentLifecycleEntry>();
  for (let index = 0; index < 60; index += 1) {
    entries.set(String(index), entry({ sessionId: `session-${index}`, occurredAt: index + 1 }));
  }
  const summary = deriveAgentCompanionActivitySummary(entries, 5);
  assert.equal(summary.items.length, 5);
  assert.equal(summary.totalCount, 60);
  assert.equal(summary.activeCount, 60);
  assert.equal(summary.items[0]?.sessionId, "session-59");
});
