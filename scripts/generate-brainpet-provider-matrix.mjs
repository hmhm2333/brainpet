#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = resolve(root, "config", "brainpet-adapter-registry.json");
const receiptsPath = resolve(root, "config", "brainpet-adapter-receipts.json");
const lifecyclePath = resolve(root, "config", "brainpet-agent-lifecycle.json");
const outputPath = resolve(root, "integrations", "brainpet-provider-support.json");

export function buildBrainPetProviderMatrix() {
  const registry = readJson(registryPath);
  const receipts = readJson(receiptsPath);
  const lifecycle = readJson(lifecyclePath);
  validateRegistry(registry, receipts, lifecycle);
  const receiptByProvider = new Map(receipts.providers.map((receipt) => [receipt.providerId, receipt]));
  return {
    schemaVersion: 2,
    generatedFrom: [
      "config/brainpet-adapter-registry.json",
      "config/brainpet-adapter-receipts.json",
      "config/brainpet-agent-lifecycle.json"
    ],
    adapterVersion: registry.adapterVersion,
    lifecycleStates: lifecycle.states,
    capabilityDimensions: registry.capabilityDimensions,
    capabilityStatuses: registry.capabilityStatuses,
    stabilityLevels: registry.stabilityLevels,
    providers: registry.providers.map((provider) => {
      const receipt = receiptByProvider.get(provider.id);
      return {
        id: provider.id,
        displayName: provider.displayName,
        kind: provider.kind,
        supportedProducts: provider.supportedProducts,
        automaticLifecycle: provider.automaticLifecycle,
        lifecycleMethod: provider.lifecycleMethod,
        installerKind: provider.installerKind,
        capabilities: provider.capabilities,
        targetPlatformLevels: provider.targetPlatformLevels,
        verifiedPlatformLevels: Object.fromEntries(registry.platforms.map((platform) => [
          platform,
          minimumStability(provider.targetPlatformLevels[platform], receipt.verifiedPlatformLevels[platform], registry.stabilityLevels),
        ])),
        evidence: receipt.evidence,
      };
    }),
    probeTargets: registry.probeTargets,
  };
}

export function serializeBrainPetProviderMatrix(matrix = buildBrainPetProviderMatrix()) {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

export function assertBrainPetProviderMatrixCurrent() {
  assert.equal(readFileSync(outputPath, "utf8").replaceAll("\r\n", "\n"), serializeBrainPetProviderMatrix(), "Generated BrainPet provider matrix is stale. Run pnpm brainpet:providers:generate.");
}

function validateRegistry(registry, receipts, lifecycle) {
  assert.equal(registry.schemaVersion, 1);
  assert.equal(receipts.schemaVersion, 1);
  assert.equal(receipts.registryVersion, registry.adapterVersion);
  assert.deepEqual(registry.capabilityDimensions, ["lifecycle", "taskNavigation", "requestActions", "message", "voice"]);
  assert.deepEqual(registry.stabilityLevels, ["unsupported", "experimental", "beta", "stable"]);
  assert.equal(new Set(registry.providers.map((provider) => provider.id)).size, registry.providers.length, "Provider IDs must be unique.");
  assert.equal(new Set(receipts.providers.map((receipt) => receipt.providerId)).size, receipts.providers.length, "Provider receipts must be unique.");
  assert.deepEqual(receipts.providers.map((receipt) => receipt.providerId).sort(), registry.providers.map((provider) => provider.id).sort(), "Every provider requires exactly one receipt.");
  for (const provider of registry.providers) {
    assert.match(provider.id, /^[a-z0-9][a-z0-9-]{0,31}$/);
    assert.deepEqual(Object.keys(provider.capabilities), registry.capabilityDimensions);
    assert.deepEqual(Object.keys(provider.targetPlatformLevels), registry.platforms);
    for (const status of Object.values(provider.capabilities)) assert.ok(registry.capabilityStatuses.includes(status), `${provider.id} has an invalid capability status.`);
    for (const level of Object.values(provider.targetPlatformLevels)) assert.ok(registry.stabilityLevels.includes(level), `${provider.id} has an invalid target stability level.`);
    if (provider.automaticLifecycle) {
      assert.equal(provider.lifecycleMethod, lifecycle.ipcMethod);
      assert.equal(provider.capabilities.lifecycle, "implemented");
    } else {
      assert.equal(provider.lifecycleMethod, null);
    }
  }
  for (const receipt of receipts.providers) {
    assert.deepEqual(Object.keys(receipt.verifiedPlatformLevels), registry.platforms);
    for (const level of Object.values(receipt.verifiedPlatformLevels)) assert.ok(registry.stabilityLevels.includes(level), `${receipt.providerId} has an invalid verified stability level.`);
  }
}

function minimumStability(target, verified, levels) {
  return levels[Math.min(levels.indexOf(target), levels.indexOf(verified))];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    assertBrainPetProviderMatrixCurrent();
    console.log("BrainPet provider matrix is current.");
  } else {
    writeFileSync(outputPath, serializeBrainPetProviderMatrix(), "utf8");
    console.log(`Generated ${outputPath}`);
  }
}
