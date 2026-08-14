import assert from "node:assert/strict";
import test from "node:test";

import { derivePrimaryCompanionView, formatPrimaryCompanionAge, formatPrimaryCompanionProvider } from "../src/primary-companion-ui.js";
import type { AgentCompanionActivitySummary } from "../src/agent-companion-activity.js";

function summary(totalCount = 7): AgentCompanionActivitySummary {
  return {
    status: "review",
    activeCount: 2,
    unreadCount: 3,
    totalCount,
    items: Array.from({ length: totalCount }, (_, index) => ({
      provider: index % 2 === 0 ? "codex" : "claude-code",
      sessionId: `session-${index}`,
      status: index === 0 ? "review" : "working",
      occurredAt: 1_000 - index,
      unread: index === 0,
      capabilities: ["observeLifecycle"],
    })),
  };
}

test("primary companion view is one bounded tray with a useful badge count", () => {
  const view = derivePrimaryCompanionView(summary(), 61_000);
  assert.equal(view.items.length, 5);
  assert.equal(view.badgeCount, 7);
  assert.equal(view.items[0]?.providerLabel, "Codex");
  assert.equal(view.items[1]?.providerLabel, "Claude");
});

test("badge count is capped for the tiny pet surface", () => {
  const view = derivePrimaryCompanionView({ ...summary(1), activeCount: 120, unreadCount: 110, totalCount: 120 }, 2_000);
  assert.equal(view.badgeCount, 99);
});

test("provider and age labels are compact and deterministic", () => {
  assert.equal(formatPrimaryCompanionProvider("workbuddy"), "WorkBuddy");
  assert.equal(formatPrimaryCompanionProvider("custom-provider-with-a-very-long-name-ignored").length, 32);
  assert.equal(formatPrimaryCompanionAge(59_999, 60_000), "now");
  assert.equal(formatPrimaryCompanionAge(0, 60_000), "1m");
  assert.equal(formatPrimaryCompanionAge(0, 3_600_000), "1h");
  assert.equal(formatPrimaryCompanionAge(0, 86_400_000), "1d");
});
