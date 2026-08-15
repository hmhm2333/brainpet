#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const [{ mapClaudeLifecycleEvent, claudeAdapterDescriptor }, { mapOpenCodeLifecycleEvent, openCodeAdapterDescriptor }, { codexAdapterDescriptor, selectLifecycleEvent }] = await Promise.all([
  importBuilt("packages/claude/dist/hooks.js"),
  importBuilt("packages/opencode/dist/opencode-plugin-runtime.js"),
  importBuilt("integrations/codex/plugins/brainpet-codex-bridge/scripts/bridge-core.mjs"),
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
