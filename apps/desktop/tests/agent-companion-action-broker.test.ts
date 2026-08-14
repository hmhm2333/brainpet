import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AgentCompanionActionBroker, type AgentCompanionActionInvocation } from "../src/agent-companion-action-broker.js";
import type { AgentCompanionActivitySummary } from "../src/agent-companion-activity.js";

const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));

function waitingSummary(overrides: Partial<AgentCompanionActivitySummary["items"][number]> = {}): AgentCompanionActivitySummary {
  return {
    status: "waiting",
    activeCount: 1,
    unreadCount: 0,
    totalCount: 1,
    items: [{
      provider: "claude",
      sessionId: "session-1",
      status: "waiting",
      occurredAt: 1_000,
      unread: false,
      capabilities: ["observeLifecycle", "respondToRequest"],
      request: {
        kind: "permission",
        requestId: "request-1",
        options: [
          { id: "once", label: "Allow once", intent: "runOnce" },
          { id: "deny", label: "Deny", intent: "deny" },
        ],
      },
      ...overrides,
    }],
  };
}

test("declared lifecycle capabilities never create actions without a registered provider", () => {
  const broker = new AgentCompanionActionBroker();
  const prompt = broker.derivePrompt(waitingSummary(), 1_000);
  assert.equal(prompt?.state, "fallback");
  assert.deepEqual(prompt?.controls, []);
});

test("request actions stay fallback-only without a stable provider request id", () => {
  const broker = new AgentCompanionActionBroker();
  broker.registerProvider({ provider: "claude", capabilities: ["respondToRequest"], execute: async () => ({ ok: true }) });
  const summary = waitingSummary({ request: { kind: "permission", options: [{ id: "once", label: "Allow once", intent: "runOnce" }] } });
  assert.equal(broker.derivePrompt(summary, 1_000)?.state, "fallback");
});

test("registered providers expose only their structured request options", async () => {
  const invocations: AgentCompanionActionInvocation[] = [];
  const broker = new AgentCompanionActionBroker();
  broker.registerProvider({ provider: "claude", capabilities: ["respondToRequest"], execute: async (invocation) => { invocations.push(invocation); return { ok: true }; } });
  const prompt = broker.derivePrompt(waitingSummary(), 1_000);
  assert.equal(prompt?.state, "ready");
  assert.deepEqual(prompt?.controls.map(({ id, label, intent }) => ({ id, label, intent })), [
    { id: "response:once", label: "Allow once", intent: "runOnce" },
    { id: "response:deny", label: "Deny", intent: "deny" },
  ]);
  assert.equal(prompt?.controls.some((control) => control.action !== "respondToRequest"), false);
  assert.deepEqual(await broker.execute(prompt!.token, "response:once", {}, 1_001), { ok: true });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].optionId, "once");
  assert.equal(invocations[0].descriptor.provider, "claude");
  assert.equal(broker.derivePrompt(waitingSummary(), 1_002), null, "successful requests are consumed until lifecycle identity changes");
});

test("open, stop, and message controls require matching registered capabilities", async () => {
  const invocations: AgentCompanionActionInvocation[] = [];
  const broker = new AgentCompanionActionBroker();
  broker.registerProvider({ provider: "claude", capabilities: ["openTask", "stopTask", "sendMessage"], execute: async (invocation) => { invocations.push(invocation); return { ok: true }; } });
  const working: AgentCompanionActivitySummary = {
    status: "working",
    activeCount: 1,
    unreadCount: 0,
    totalCount: 1,
    items: [{ provider: "claude", sessionId: "session-2", status: "working", occurredAt: 2_000, unread: false, capabilities: ["observeLifecycle", "openTask", "stopTask", "sendMessage", "voice"] }],
  };
  const openPrompt = broker.derivePrompt(working, 2_000)!;
  assert.deepEqual(openPrompt.controls.map((control) => control.action), ["openTask", "stopTask", "sendMessage"]);
  assert.deepEqual(await broker.execute(openPrompt.token, "sendMessage", { message: "  Keep going  " }, 2_001), { ok: true });
  assert.equal(invocations[0].message, "Keep going");
  assert.equal(invocations[0].descriptor.action, "sendMessage");

  const next = { ...working, items: [{ ...working.items[0], occurredAt: 2_100, capabilities: ["observeLifecycle", "openTask"] as const }] };
  const nextPrompt = broker.derivePrompt(next, 2_100)!;
  assert.deepEqual(nextPrompt.controls.map((control) => control.action), ["openTask"], "adapter capabilities cannot add controls missing from the event contract");
});

test("unregistering a provider invalidates minted controls and restores fallback", async () => {
  const broker = new AgentCompanionActionBroker();
  const unregister = broker.registerProvider({ provider: "claude", capabilities: ["respondToRequest"], execute: async () => ({ ok: true }) });
  const prompt = broker.derivePrompt(waitingSummary(), 1_000)!;
  unregister();
  assert.deepEqual(await broker.execute(prompt.token, "response:once", {}, 1_001), { ok: false, code: "invalid", error: "This action is no longer available." });
  assert.equal(broker.derivePrompt(waitingSummary(), 1_002)?.state, "fallback");
});

test("expired and duplicate submissions never reach the provider twice", async () => {
  let resolveExecution: ((result: { ok: true }) => void) | undefined;
  let calls = 0;
  const broker = new AgentCompanionActionBroker();
  broker.registerProvider({
    provider: "claude",
    capabilities: ["respondToRequest"],
    execute: () => {
      calls += 1;
      return new Promise((resolve) => { resolveExecution = resolve; });
    },
  });
  const first = broker.derivePrompt(waitingSummary(), 1_000)!;
  const pending = broker.execute(first.token, "response:once", {}, 1_001);
  assert.deepEqual(await broker.execute(first.token, "response:once", {}, 1_002), { ok: false, code: "duplicate", error: "This action is already being submitted." });
  assert.equal(calls, 1);
  resolveExecution?.({ ok: true });
  await pending;

  const later = waitingSummary({ occurredAt: 2_000, request: { ...waitingSummary().items[0].request!, requestId: "request-2" } });
  const expiring = broker.derivePrompt(later, 2_000)!;
  assert.deepEqual(await broker.execute(expiring.token, "response:once", {}, 302_001), { ok: false, code: "expired", error: "This action has expired." });
  assert.equal(calls, 1);
});

test("provider failures retain the prompt with a bounded one-line error", async () => {
  const broker = new AgentCompanionActionBroker();
  broker.registerProvider({ provider: "claude", capabilities: ["respondToRequest"], execute: async () => ({ ok: false, error: `Denied\n${"x".repeat(200)}` }) });
  const prompt = broker.derivePrompt(waitingSummary(), 1_000)!;
  const result = await broker.execute(prompt.token, "response:deny", {}, 1_001);
  assert.equal(result.ok, false);
  const retained = broker.derivePrompt(waitingSummary(), 1_002);
  assert.equal(retained?.state, "error");
  assert.equal(retained?.error?.includes("\n"), false);
  assert.equal((retained?.error?.length ?? 0) <= 96, true);
});

test("the broker contains no arbitrary shell or private IPC execution path", () => {
  const source = readFileSync(resolve(desktopRoot, "src/agent-companion-action-broker.ts"), "utf8");
  assert.doesNotMatch(source, /child_process|execFile|spawn\(|shell\.open|ipcMain|webContents\.send/);
  assert.match(source, /registerProvider/);
  assert.match(source, /validateAgentCompanionActionDescriptor/);
});
