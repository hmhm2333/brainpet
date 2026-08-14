import assert from "node:assert/strict";
import test from "node:test";

import { deriveAgentCompanionPromptActions, validateAgentCompanionActionDescriptor, validateAgentCompanionCapabilities, type AgentCompanionCapability } from "../src/agent-companion-capabilities.js";

function capabilities(...values: AgentCompanionCapability[]): ReadonlySet<AgentCompanionCapability> {
  return new Set(values);
}

test("host action buttons stay hidden when a provider has not declared support", () => {
  assert.deepEqual(deriveAgentCompanionPromptActions({
    status: "waiting",
    capabilities: capabilities("observeLifecycle"),
    hasRequest: true,
  }), []);
});

test("working tasks expose only the actions backed by provider capabilities", () => {
  assert.deepEqual(deriveAgentCompanionPromptActions({
    status: "working",
    capabilities: capabilities("openTask", "stopTask", "respondToRequest", "sendMessage"),
    hasRequest: false,
  }), ["openTask", "stopTask", "sendMessage"]);
});

test("request responses require both a waiting request and provider support", () => {
  const providerCapabilities = capabilities("openTask", "respondToRequest");
  assert.deepEqual(deriveAgentCompanionPromptActions({ status: "waiting", capabilities: providerCapabilities, hasRequest: false }), ["openTask"]);
  assert.deepEqual(deriveAgentCompanionPromptActions({ status: "waiting", capabilities: providerCapabilities, hasRequest: true }), ["openTask", "respondToRequest"]);
});

test("voice can start without an active task when the provider supports it", () => {
  assert.deepEqual(deriveAgentCompanionPromptActions({
    status: "idle",
    capabilities: capabilities("openTask", "voice"),
    hasRequest: false,
  }), ["voice"]);
});

test("provider registrations reject unknown capabilities and deduplicate known ones", () => {
  assert.deepEqual(validateAgentCompanionCapabilities(["observeLifecycle", "openTask", "openTask"]), ["observeLifecycle", "openTask"]);
  assert.throws(() => validateAgentCompanionCapabilities(["observeLifecycle", "privateCodexIpc"]), /invalid/);
  assert.throws(() => validateAgentCompanionCapabilities("openTask"), /array/);
});

test("future host actions require a bounded expiry and an opaque one-time nonce", () => {
  const descriptor = { action: "respondToRequest", provider: "codex", sessionId: "session-1", requestId: "request-1", expiresAt: 1_100, nonce: "abcdefghijklmnop" } as const;
  assert.deepEqual(validateAgentCompanionActionDescriptor(descriptor, 1_000), descriptor);
  assert.throws(() => validateAgentCompanionActionDescriptor({ ...descriptor, expiresAt: 999 }, 1_000), /expiry/);
  assert.throws(() => validateAgentCompanionActionDescriptor({ ...descriptor, nonce: "short" }, 1_000), /nonce/);
});
