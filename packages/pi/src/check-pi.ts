import assert from "node:assert/strict";

import { allowedReactions } from "@open-pets/client";

import extension from "./extension.js";
import { classifyPiEvent, classifyPiToolExecutionStart, createOpenPetsPiExtension, createOpenPetsPiRuntime, getPiOpenPetsHelp, normalizePiEvent, parseOpenPetsCommand, shouldIgnoreOpenPetsTool, validateManualSpeech, type OpenPetsPiExtensionApi } from "./runtime.js";

assert.equal(typeof extension, "function");
assert.equal(typeof getPiOpenPetsHelp(), "string");
assert.deepEqual(normalizePiEvent({ type: "agent_start" }), { type: "agent_start", payload: { type: "agent_start" } });
assert.deepEqual(normalizePiEvent({ type: "agent_start", payload: { reason: "startup" } }), { type: "agent_start", payload: { reason: "startup" } });

assert.deepEqual(classifyPiEvent({ type: "session_start", prompt: "secret" }), { reaction: "waving" });
assert.deepEqual(classifyPiEvent({ type: "agent_start" }), { reaction: "thinking" });
assert.deepEqual(classifyPiEvent({ type: "turn_start" }), { reaction: "working" });
assert.deepEqual(classifyPiEvent({ type: "session_shutdown" }), { reaction: "idle" });
assert.deepEqual(classifyPiEvent({ type: "agent_end" }), { reaction: "success", clearError: true });
assert.deepEqual(classifyPiEvent({ type: "tool_execution_end", isError: true, result: "SECRET_STACK" }), { reaction: "error", speech: "error", markError: true });
assert.equal(classifyPiEvent({ type: "tool_execution_end", isError: false, result: "SECRET_STACK" }), undefined);
assert.equal(classifyPiEvent({ type: "input", text: "do not inspect" }), undefined);
assert.equal(classifyPiEvent({ type: "message_update", message: "do not inspect" }), undefined);
assert.equal(classifyPiEvent({ type: "tool_result", content: "do not inspect" }), undefined);

assert.equal(classifyPiToolExecutionStart("edit", {}), "editing");
assert.equal(classifyPiToolExecutionStart("apply_patch", {}), "editing");
assert.equal(classifyPiToolExecutionStart("bash", { command: "pnpm test -- --secret token=abc" }), "testing");
assert.equal(classifyPiToolExecutionStart("bash", { command: "ls" }), "running");
assert.equal(classifyPiToolExecutionStart("read", {}), "working");
assert.equal(classifyPiToolExecutionStart("openpets_status", {}), undefined);
assert.equal(shouldIgnoreOpenPetsTool("openpets_openpets_say"), true);

assert.deepEqual(parseOpenPetsCommand(""), { kind: "help" });
assert.deepEqual(parseOpenPetsCommand("status"), { kind: "status" });
assert.deepEqual(parseOpenPetsCommand("test"), { kind: "test" });
assert.deepEqual(parseOpenPetsCommand("react success"), { kind: "react", reaction: "success" });
assert.deepEqual(parseOpenPetsCommand("say Ready"), { kind: "say", message: "Ready" });
for (const reaction of allowedReactions) assert.deepEqual(parseOpenPetsCommand(`react ${reaction}`), { kind: "react", reaction });
assert.throws(() => parseOpenPetsCommand("react nope"), /Invalid OpenPets reaction/);
assert.throws(() => parseOpenPetsCommand("status extra"), /Usage/);

assert.equal(validateManualSpeech("  Ready  "), "Ready");
for (const unsafe of [
  "",
  "line one\nline two",
  "x".repeat(141),
  "const token = 1",
  "https://example.com",
  "/Users/alvin/secret.txt",
  "../secret.txt",
  "token=abc123",
  "-----BEGIN PRIVATE KEY-----abc",
]) {
  assert.throws(() => validateManualSpeech(unsafe));
}

{
  const calls: string[] = [];
  const scheduled: Array<() => Promise<void>> = [];
  const runtime = createOpenPetsPiRuntime({
    now: () => 1_000,
    random: () => 0,
    schedule: (work) => { scheduled.push(work); },
    clientFactory: () => ({
      hello: async () => ({}),
      status: async () => ({ ok: true, appRunning: true }),
      listPets: async () => ({ ok: true, defaultPetId: "builtin", pets: [] }),
      installPet: async () => ({ ok: true, petId: "x", displayName: "X", installed: true }),
      installLocalPet: async () => ({ ok: true, petId: "x", displayName: "X", installed: true }),
      acquireLease: async () => { throw new Error("no leases in pi mvp"); },
      heartbeatLease: async () => ({ leaseId: "x", expiresAt: 0 }),
      releaseLease: async () => ({ released: true }),
      reportAgentActivity: async () => ({}),
      react: async (reaction) => { calls.push(`react:${reaction}`); },
      say: async (message, options) => { calls.push(`say:${message}:${options?.reaction ?? "none"}`); },
      showMedia: async () => ({ ok: true, shown: true }),
    }),
  });

  runtime.handleEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "pnpm test /Users/alvin/private" }, prompt: "PRIVATE_PROMPT" });
  runtime.handleEvent({ type: "tool_execution_end", isError: true, result: "STACK /Users/alvin/private token=abc" });
  runtime.handleEvent({ type: "agent_end" });
  assert.deepEqual(calls, [], "Pi lifecycle events must never emit implicit pet actions");
  assert.equal(scheduled.length, 0, "Pi lifecycle events must not schedule hidden transport work");
}

{
  const events: string[] = [];
  let commandHandler: ((args: string, ctx?: unknown) => unknown) | undefined;
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const calls: string[] = [];
  const api: OpenPetsPiExtensionApi = {
    on: (eventName, handler) => { events.push(eventName); handlers.set(eventName, handler); },
    registerCommand: (_name, command) => { commandHandler = command.handler; },
  };
  const scheduled: Array<() => Promise<void>> = [];
  const runtime = createOpenPetsPiExtension(api, {
    schedule: (work) => { scheduled.push(work); },
    clientFactory: () => ({
      hello: async () => ({}),
      status: async () => ({ ok: true, appRunning: true }),
      listPets: async () => ({ ok: true, defaultPetId: "builtin", pets: [] }),
      installPet: async () => ({ ok: true, petId: "x", displayName: "X", installed: true }),
      installLocalPet: async () => ({ ok: true, petId: "x", displayName: "X", installed: true }),
      acquireLease: async () => { throw new Error("no leases in pi mvp"); },
      heartbeatLease: async () => ({ leaseId: "x", expiresAt: 0 }),
      releaseLease: async () => ({ released: true }),
      reportAgentActivity: async () => ({}),
      react: async (reaction) => { calls.push(`react:${reaction}`); },
      say: async (message) => { calls.push(`say:${message}`); },
      showMedia: async () => ({ ok: true, shown: true }),
    }),
  });
  assert.equal(typeof runtime.handleEvent, "function");
  assert.deepEqual(events, [], "Pi extension must not subscribe to automatic lifecycle events");
  assert.equal(typeof commandHandler, "function");
  runtime.handleEvent({ type: "agent_start", prompt: "PRIVATE_PROMPT" });
  assert.deepEqual(calls, []);
  assert.equal(scheduled.length, 0);
}

console.log("Pi integration package checks passed.");
