import assert from "node:assert/strict";
import test from "node:test";

import { validateAgentLifecycleParams } from "../src/local-ipc-protocol.js";

const base = {
  schemaVersion: 1,
  agent: "claude",
  sessionId: "session-1",
  state: "waiting",
  occurredAt: 1_000,
  capabilities: ["observeLifecycle", "respondToRequest"],
};

test("request protocol accepts the six M4 request kinds and structured options", () => {
  for (const kind of ["permission", "question", "review", "openLink", "stop", "continue"] as const) {
    const parsed = validateAgentLifecycleParams({ ...base, request: { kind, requestId: `request-${kind}`, options: [{ id: "ok", label: "Continue", intent: "continue" }] } });
    assert.equal(parsed.request?.kind, kind);
    assert.deepEqual(parsed.request?.options, [{ id: "ok", label: "Continue", intent: "continue" }]);
  }
});

test("request protocol rejects duplicate ids, multiline labels, unknown intents, and non-waiting requests", () => {
  assert.throws(() => validateAgentLifecycleParams({ ...base, request: { kind: "question", options: [{ id: "same", label: "A", intent: "answer" }, { id: "same", label: "B", intent: "answer" }] } }), /unique/);
  assert.throws(() => validateAgentLifecycleParams({ ...base, request: { kind: "question", options: [{ id: "a", label: "A\nB", intent: "answer" }] } }), /label/);
  assert.throws(() => validateAgentLifecycleParams({ ...base, request: { kind: "question", options: [{ id: "a", label: "A", intent: "shell" }] } }), /intent/);
  assert.throws(() => validateAgentLifecycleParams({ ...base, state: "working", request: { kind: "continue" } }), /waiting state/);
});
