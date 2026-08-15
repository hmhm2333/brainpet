import assert from "node:assert/strict";

import { createNormalizedAgentLifecycleEvent, hookSpeechPools, pickHookSpeech, validateHookSpeech } from "./index.js";

assert.deepEqual(createNormalizedAgentLifecycleEvent({ agent: "claude", sessionId: "session-1", turnId: "turn-1", state: "waiting", occurredAt: 123, requestKind: "permission" }), {
  schemaVersion: 1,
  agent: "claude",
  sessionId: "session-1",
  turnId: "turn-1",
  state: "waiting",
  occurredAt: 123,
  capabilities: ["observeLifecycle"],
  request: { kind: "permission" },
});
assert.throws(() => createNormalizedAgentLifecycleEvent({ agent: "Claude!", sessionId: "session-1", state: "working" }));
assert.throws(() => createNormalizedAgentLifecycleEvent({ agent: "claude", sessionId: "private\ncontent", state: "working" }));

assert.equal(pickHookSpeech("thinking", () => 0), "Thinking it through");
assert.equal(pickHookSpeech("success", () => 0.99), "Nice, finished");

for (const [category, messages] of Object.entries(hookSpeechPools)) {
  for (const message of messages) {
    assert.match(message, /^[A-Z]/, `${category} hook speech must start with uppercase: ${message}`);
    assert.equal(validateHookSpeech(message), message);
  }
}

for (const unsafe of ["", "a".repeat(141), "line\nbreak", "const x = 1", "https://example.com", "/Users/alvin/project", "api_key=secret"]) {
  assert.throws(() => validateHookSpeech(unsafe));
}

console.error("Agent event speech validation passed.");
