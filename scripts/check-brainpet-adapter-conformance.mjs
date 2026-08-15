#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { assertBrainPetAdapterContractsCurrent } from "./generate-brainpet-adapter-contracts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = readJson("config/brainpet-adapter-conformance.json");
const lifecycle = readJson("config/brainpet-agent-lifecycle.json");
const registry = readJson("config/brainpet-adapter-registry.json");

assertBrainPetAdapterContractsCurrent();
assert.equal(fixture.schemaVersion, 1);
assert.deepEqual(fixture.rejectedFields, lifecycle.privacyRejectedFields);

const [{ mapClaudeLifecycleEvent, claudeAdapterDescriptor, handleClaudeHookPayload }, { createOpenPetsOpenCodeHooks, mapOpenCodeLifecycleEvent, openCodeAdapterDescriptor }, { codexAdapterDescriptor, selectLifecycleEvent }, { resolveTargetProfile }] = await Promise.all([
  importBuilt("packages/claude/dist/hooks.js"),
  importBuilt("packages/opencode/dist/opencode-plugin-runtime.js"),
  importBuilt("integrations/codex/plugins/brainpet-codex-bridge/scripts/bridge-core.mjs"),
  importBuilt("packages/client/dist/index.js"),
]);

const descriptors = new Map([
  ["codex", codexAdapterDescriptor],
  ["claude", claudeAdapterDescriptor],
  ["opencode", openCodeAdapterDescriptor],
]);
for (const providerId of ["codex", "claude", "opencode"]) {
  const registryDescriptor = registry.providers.find((provider) => provider.id === providerId);
  const runtimeDescriptor = descriptors.get(providerId);
  assert.ok(registryDescriptor && runtimeDescriptor);
  for (const key of ["id", "displayName", "supportedProducts", "automaticLifecycle", "lifecycleMethod", "installerKind", "capabilities"]) {
    assert.deepEqual(runtimeDescriptor[key], registryDescriptor[key], `${providerId} runtime descriptor drifted at ${key}`);
  }
}

const mappers = {
  codex: (input, occurredAt) => selectLifecycleEvent(input, occurredAt),
  claude: (input, occurredAt) => mapClaudeLifecycleEvent(input, occurredAt),
  opencode: (input, occurredAt) => mapOpenCodeLifecycleEvent(input, occurredAt),
};

for (const testCase of fixture.cases) {
  const mapper = mappers[testCase.provider];
  assert.equal(typeof mapper, "function", `Unknown fixture provider: ${testCase.provider}`);
  const actual = mapper(testCase.input, fixture.occurredAt);
  assert.deepEqual(actual, testCase.expected, `Adapter conformance mismatch: ${testCase.id}`);
  if (actual) {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(testCase.expected).sort(), `Adapter emitted an undeclared field: ${testCase.id}`);
    for (const field of fixture.rejectedFields) assert.equal(field in actual, false, `${testCase.id} leaked rejected field ${field}`);
  }
}

for (const path of ["packages/claude/src/hooks.ts", "packages/opencode/src/opencode-plugin-runtime.ts", "integrations/codex/plugins/brainpet-codex-bridge/scripts/bridge.mjs"]) {
  const source = readFileSync(join(root, path), "utf8");
  assert.doesNotMatch(source, /client\.(?:say|react|acquireLease)\s*\(/, `${path} contains an automatic secondary lifecycle transport.`);
}
const piSource = readFileSync(join(root, "packages/pi/src/runtime.ts"), "utf8");
assert.doesNotMatch(piSource, /\.on\?\.\(/, "Pi is not a registered lifecycle adapter and must not subscribe to automatic events.");

await verifyDualHostAdapterRouting({ handleClaudeHookPayload, createOpenPetsOpenCodeHooks, resolveTargetProfile });

const started = performance.now();
const missingSession = fixture.cases.filter((testCase) => testCase.expected === null);
for (let index = 0; index < 1_000; index += 1) {
  for (const testCase of missingSession) assert.equal(mappers[testCase.provider](testCase.input, fixture.occurredAt), null);
}
assert.ok(performance.now() - started < 1_000, "Invalid events must no-op within the adapter deadline.");

console.log(`BrainPet adapter conformance passed (${fixture.cases.length} shared cases).`);

function readJson(path) { return JSON.parse(readFileSync(join(root, path), "utf8")); }
async function importBuilt(path) {
  try { return await import(pathToFileURL(join(root, path)).href); }
  catch (error) { throw new Error(`Built adapter module is unavailable (${path}); run pnpm build first.`, { cause: error }); }
}

async function verifyDualHostAdapterRouting({ handleClaudeHookPayload, createOpenPetsOpenCodeHooks, resolveTargetProfile }) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "brainpet-adapter-dual-host-"));
  const hosts = await Promise.all([startTargetHost("brainpet"), startTargetHost("openpets")]);
  const byProduct = Object.fromEntries(hosts.map((host) => [host.product, host]));
  const saved = Object.fromEntries(["OPENPETS_DISCOVERY_FILE", "APPDATA", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME"].map((key) => [key, process.env[key]]));
  try {
    delete process.env.OPENPETS_DISCOVERY_FILE;
    if (process.platform === "win32") process.env.APPDATA = fixtureRoot;
    else {
      delete process.env.XDG_RUNTIME_DIR;
      process.env.XDG_CONFIG_HOME = fixtureRoot;
    }
    for (const product of ["brainpet", "openpets"]) {
      const profile = resolveTargetProfile(product);
      const host = byProduct[product];
      mkdirSync(dirname(profile.discoveryPath), { recursive: true });
      writeFileSync(profile.discoveryPath, JSON.stringify({
        protocol: "openpets-ipc",
        protocolVersion: 1,
        product,
        appId: profile.appId,
        endpoint: host.endpoint,
        token: host.token,
        appVersion: "0.0.0-test",
        pid: process.pid,
        platform: process.platform,
      }), "utf8");
    }

    for (const product of ["brainpet", "openpets"]) {
      await handleClaudeHookPayload(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: `claude-${product}` }), { product });
      const scheduled = [];
      const hooks = createOpenPetsOpenCodeHooks({ product, schedule: (work) => scheduled.push(work), now: () => fixture.occurredAt });
      hooks.event({ event: { type: "session.status", properties: { sessionID: `opencode-${product}`, status: { type: "busy" } } } });
      assert.equal(scheduled.length, 1);
      await scheduled.shift()();
    }

    const brainProfile = resolveTargetProfile("brainpet");
    const openProfile = resolveTargetProfile("openpets");
    await runCodexBridge(brainProfile.discoveryPath, "codex-brainpet");
    const openBefore = byProduct.openpets.requests.length;
    await runCodexBridge(openProfile.discoveryPath, "codex-must-not-route-to-openpets");
    assert.equal(byProduct.openpets.requests.length, openBefore, "Codex bridge must reject an OpenPets discovery endpoint");

    assert.deepEqual(byProduct.brainpet.requests.map((request) => [request.method, request.params.agent]), [
      ["agent.activity", "claude"],
      ["agent.activity", "opencode"],
      ["agent.activity", "codex"],
    ]);
    assert.deepEqual(byProduct.openpets.requests.map((request) => [request.method, request.params.agent]), [
      ["agent.activity", "claude"],
      ["agent.activity", "opencode"],
    ]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(hosts.map((host) => host.close()));
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

async function startTargetHost(product) {
  const token = `${product}-adapter-token`.padEnd(32, "x");
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.slice(0, chunk.indexOf("\n")));
      requests.push(request);
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { accepted: true } })}\n`);
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Adapter target host did not bind.");
  return {
    product,
    token,
    endpoint: `tcp://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

async function runCodexBridge(discoveryPath, sessionId) {
  const bridgePath = join(root, "integrations/codex/plugins/brainpet-codex-bridge/scripts/bridge.mjs");
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      cwd: root,
      env: { ...process.env, OPENPETS_DISCOVERY_FILE: discoveryPath },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`Codex bridge exited ${code}`)));
    child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId }));
  });
}
