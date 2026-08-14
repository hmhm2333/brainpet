#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetReleaseTargetIds } from "./brainpet-release-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps", "desktop");
const config = readFileSync(join(desktop, "electron-builder.brainpet.yml"), "utf8");
assert.match(config, /^appId: dev\.brainpet\.app$/m);
assert.match(config, /^productName: BrainPet$/m);
assert.match(config, /^executableName: brainpet$/m);
assert.match(config, /dist-brainpet/);
assert.match(config, /brainpet-installer\.nsh/);
assert.match(readFileSync(join(desktop, "build", "brainpet-installer.nsh"), "utf8"), /runtime-install\.json/);
assert.ok(existsSync(join(desktop, "scripts", "validate-brainpet-package.mjs")));

const bridgeRoot = join(root, "integrations", "codex", "plugins", "brainpet-codex-bridge");
const bridgeContract = JSON.parse(readFileSync(join(bridgeRoot, "brainpet.bridge.json"), "utf8"));
assert.deepEqual(bridgeContract.releaseTargets, brainPetReleaseTargetIds);
assert.match(readFileSync(join(bridgeRoot, "scripts", "bridge.sh"), "utf8"), /Linux\) platform="linux"/);
assert.ok(existsSync(join(bridgeRoot, "assets", "brainpet-plugin-icon.svg")));
assert.ok(existsSync(join(root, "PRIVACY.md")));

const providerMatrix = JSON.parse(readFileSync(join(root, "integrations", "brainpet-provider-support.json"), "utf8"));
assert.deepEqual(providerMatrix.dimensions, ["lifecycle", "taskNavigation", "requestActions", "message", "voice"]);
for (const provider of providerMatrix.providers) {
  assert.deepEqual(Object.keys(provider.support), providerMatrix.dimensions);
  for (const value of Object.values(provider.support)) assert.ok(providerMatrix.statuses.includes(value), `${provider.id} has an invalid support status.`);
}
const codex = providerMatrix.providers.find((provider) => provider.id === "codex");
assert.equal(codex.support.lifecycle, "implemented");
assert.equal(codex.support.requestActions, "unavailable");
console.log(`BrainPet release source validation passed (${brainPetReleaseTargetIds.length} targets, ${providerMatrix.providers.length} providers).`);
