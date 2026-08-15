import assert from "node:assert/strict";

import extension from "./extension.js";
import { createOpenPetsPiExtension, type OpenPetsPiExtensionApi } from "./runtime.js";

const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
let commandHandler: ((args: string, ctx?: unknown) => unknown) | undefined;
const notifications: string[] = [];
const calls: string[] = [];

const api: OpenPetsPiExtensionApi = {
  on(eventName, handler) {
    handlers.set(eventName, handler);
  },
  registerCommand(name, command) {
    assert.equal(name, "openpets");
    commandHandler = command.handler;
  },
};

const scheduled: Array<() => Promise<void>> = [];
const runtime = createOpenPetsPiExtension(api, {
  now: () => Date.now(),
  random: () => 0,
  schedule: (work) => { scheduled.push(work); },
  clientFactory: () => ({
    hello: async () => ({}),
    status: async () => ({ ok: true, appRunning: true }),
    listPets: async () => ({ ok: true, defaultPetId: "builtin", pets: [] }),
    installPet: async () => ({ ok: true, petId: "x", displayName: "X", installed: true }),
    installLocalPet: async () => ({ ok: true, petId: "x", displayName: "X", installed: true }),
    acquireLease: async () => { throw new Error("leases disabled"); },
    heartbeatLease: async () => ({ leaseId: "x", expiresAt: 0 }),
    releaseLease: async () => ({ released: true }),
    reportAgentActivity: async () => ({}),
    react: async (reaction) => { calls.push(`react:${reaction}`); },
    say: async (message, options) => { calls.push(`say:${message}:${options?.reaction ?? "none"}`); },
    showMedia: async () => ({ ok: true, shown: true }),
  }),
});

assert.equal(typeof extension, "function");
assert.equal(typeof runtime.handleEvent, "function");
assert.equal(typeof commandHandler, "function");
assert.equal(handlers.size, 0, "Pi must not register an implicit lifecycle transport");
runtime.handleEvent({ type: "session_start", prompt: "PRIVATE_PROMPT" });
assert.equal(scheduled.length, 0);
assert.equal(calls.length, 0);

await commandHandler?.("status", { ui: { notify: (message: string) => notifications.push(message) } });
await commandHandler?.("test", { ui: { notify: (message: string) => notifications.push(message) } });
assert.ok(notifications.includes("OpenPets is connected."));
assert.ok(calls.includes("say:Pi connected:waving"));

console.log("Pi compatibility smoke checks passed.");
