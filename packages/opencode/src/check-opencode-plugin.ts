import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { OpenPetsClient, OpenPetsReaction } from "@open-pets/client";

import plugin, { openPetsOpenCodePluginId } from "./plugin.js";
import {
  classifyOpenCodeBusEvent,
  classifyOpenCodeToolReaction,
  createOpenCodeInstallerPlan,
  createOpenPetsOpenCodeHooks,
  getDefaultOpenCodeThrottlePath,
  isReactionExcluded,
  mapOpenCodeLifecycleEvent,
  openCodeAdapterDescriptor,
  shouldIgnoreOpenPetsTool,
} from "./opencode-plugin-runtime.js";

assert.equal(plugin.id, openPetsOpenCodePluginId);
assert.equal(typeof plugin.server, "function");
const packagePlugin = await import("@open-pets/opencode/server");
assert.equal(packagePlugin.default.id, openPetsOpenCodePluginId);
assert.equal(openCodeAdapterDescriptor.lifecycleMethod, "agent.activity");
assert.equal(createOpenCodeInstallerPlan("brainpet", "global").target.product, "brainpet");

// Legacy classifiers remain source-compatible, but automatic delivery no longer
// consumes them. agent.activity is the only automatic transport.
assert.equal(classifyOpenCodeToolReaction("edit", {}), "editing");
assert.deepEqual(classifyOpenCodeBusEvent({ type: "session.error" }), { reaction: "error", speechCategory: "error" });
assert.equal(isReactionExcluded("success", new Set(["success"])), true);
assert.equal(shouldIgnoreOpenPetsTool("openpets_openpets_say"), true);
assert.ok(getDefaultOpenCodeThrottlePath().endsWith("opencode-hook-throttle.json"));

assert.deepEqual(mapOpenCodeLifecycleEvent({ type: "permission.asked", properties: { sessionID: "session-1" } }, 123), {
  schemaVersion: 1,
  agent: "opencode",
  sessionId: "session-1",
  state: "waiting",
  occurredAt: 123,
  capabilities: ["observeLifecycle"],
  request: { kind: "permission" },
});
assert.equal(mapOpenCodeLifecycleEvent({ type: "session.error" }, 123), null);

const lifecycleCalls: unknown[] = [];
const forbiddenCalls: string[] = [];
const client: OpenPetsClient = {
  hello: async () => ({}),
  status: async () => ({ ok: true, appRunning: true }),
  listPets: async () => ({ ok: true, pets: [], defaultPetId: "builtin" }),
  installPet: async () => { throw new Error("unused"); },
  installLocalPet: async () => { throw new Error("unused"); },
  acquireLease: async () => { forbiddenCalls.push("lease.acquire"); throw new Error("automatic lifecycle must not acquire a lease"); },
  heartbeatLease: async () => { throw new Error("unused"); },
  releaseLease: async () => { throw new Error("unused"); },
  reportAgentActivity: async (event) => { lifecycleCalls.push(event); return { ok: true }; },
  react: async (reaction: OpenPetsReaction) => { forbiddenCalls.push(`pet.react:${reaction}`); },
  say: async (message: string) => { forbiddenCalls.push(`pet.say:${message}`); },
  showMedia: async () => ({ ok: true, shown: true }),
};

const dir = mkdtempSync(join(tmpdir(), "openpets-opencode-lifecycle-"));
try {
  const scheduled: Array<() => Promise<void>> = [];
  const hooks = createOpenPetsOpenCodeHooks({
    pet: "fixer",
    excludeReactions: ["success", "thinking"],
    clientFactory: () => client,
    schedule: (work) => { scheduled.push(work); },
    throttlePath: join(dir, "throttle.json"),
    now: () => 1_000,
  });

  hooks.event({ event: { type: "session.status", properties: { sessionID: "session-1", status: { type: "busy" } } } });
  hooks.event({ event: { type: "permission.asked", properties: { sessionID: "session-1" } } });
  hooks["chat.message"]({ sessionID: "session-1" }, {});
  hooks["tool.execute.before"]({ tool: "edit", sessionID: "session-1" }, { args: { prompt: "private" } });
  hooks["tool.execute.before"]({ tool: "openpets_openpets_say", sessionID: "session-1" }, { args: {} });

  assert.equal(scheduled.length, 4, "each valid provider event schedules exactly one lifecycle update");
  await Promise.all(scheduled.splice(0).map((work) => work()));
  assert.equal(lifecycleCalls.length, 4);
  assert.deepEqual((lifecycleCalls[0] as { state: string }).state, "working");
  assert.deepEqual((lifecycleCalls[1] as { state: string }).state, "waiting");
  assert.deepEqual((lifecycleCalls[2] as { state: string }).state, "working");
  assert.deepEqual((lifecycleCalls[3] as { state: string }).state, "working");
  assert.deepEqual(forbiddenCalls, [], "automatic OpenCode events must never call lease, pet.react, or pet.say");

  const errors: string[] = [];
  const failingHooks = createOpenPetsOpenCodeHooks({
    clientFactory: () => ({ ...client, reportAgentActivity: async () => { throw new Error("private failure detail"); } }),
    schedule: (work) => { scheduled.push(work); },
    debugLog: (message) => errors.push(message),
    now: () => 2_000,
  });
  failingHooks.event({ event: { type: "session.error", properties: { sessionID: "session-failure" } } });
  await scheduled.shift()?.();
  assert.equal(errors.length, 1, "transport failures fail open without a second channel");
  assert.deepEqual(forbiddenCalls, []);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.error("OpenCode plugin validation passed.");
