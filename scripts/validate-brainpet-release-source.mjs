#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract, brainPetReleaseTargetIds } from "./brainpet-release-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps", "desktop");
const lifecycleContract = JSON.parse(readFileSync(join(root, "config", "brainpet-agent-lifecycle.json"), "utf8"));
const baseConfig = readFileSync(join(desktop, "electron-builder.brainpet.base.yml"), "utf8");
const privateConfig = readFileSync(join(desktop, "electron-builder.brainpet.private.yml"), "utf8");
const publicConfig = readFileSync(join(desktop, "electron-builder.brainpet.public.yml"), "utf8");
assert.match(baseConfig, /^appId: dev\.brainpet\.app$/m);
assert.match(baseConfig, /^productName: BrainPet$/m);
assert.match(baseConfig, /^executableName: brainpet$/m);
assert.match(baseConfig, /brainpet-installer\.nsh/);
assert.match(baseConfig, /brainpetDistribution:/);
assert.match(privateConfig, /dist-brainpet\/private-test/);
assert.match(privateConfig, /signAndEditExecutable: false/);
assert.match(publicConfig, /dist-brainpet\/public-release/);
assert.match(publicConfig, /hardenedRuntime: true/);
assert.match(publicConfig, /verifyUpdateCodeSignature: true/);
assert.equal(brainPetDistributionContract.identity.appId, "dev.brainpet.app");
assert.equal(brainPetDistributionContract.identity.executableName, "brainpet");
assert.match(readFileSync(join(desktop, "build", "brainpet-installer.nsh"), "utf8"), /runtime-install\.json/);
assert.ok(existsSync(join(desktop, "scripts", "validate-brainpet-package.mjs")));

const bridgeRoot = join(root, "integrations", "codex", "plugins", "brainpet-codex-bridge");
const bridgeContract = JSON.parse(readFileSync(join(bridgeRoot, "brainpet.bridge.json"), "utf8"));
assert.deepEqual(bridgeContract.releaseTargets, brainPetReleaseTargetIds);
assert.equal(bridgeContract.bridgeVersion, brainPetDistributionContract.bridge.version);
assert.equal(bridgeContract.minimumRuntimeIpcVersion, brainPetDistributionContract.bridge.minimumRuntimeIpcVersion);
assert.equal(bridgeContract.hookDeadlineMs, brainPetDistributionContract.bridge.hookDeadlineMs);
assert.equal(bridgeContract.connectAttemptMs, brainPetDistributionContract.bridge.connectAttemptMs);
assert.match(readFileSync(join(bridgeRoot, "scripts", "bridge.sh"), "utf8"), /Linux\) platform="linux"/);
assert.ok(existsSync(join(bridgeRoot, "assets", "brainpet-plugin-icon.svg")));
assert.ok(existsSync(join(root, "PRIVACY.md")));
assert.deepEqual(bridgeContract.privacy.allowedFields, [...lifecycleContract.requiredFields, ...lifecycleContract.optionalFields]);
assert.deepEqual(bridgeContract.privacy.rejectedFields, lifecycleContract.privacyRejectedFields);
const privacyText = readFileSync(join(root, "PRIVACY.md"), "utf8");
for (const rejectedField of lifecycleContract.privacyRejectedFields) assert.match(privacyText.toLowerCase(), new RegExp(rejectedField.replace(/[A-Z]/g, (letter) => `.?${letter.toLowerCase()}`)), `Privacy policy must name rejected field ${rejectedField}.`);
const ipcProtocolSource = readFileSync(join(desktop, "src", "local-ipc-protocol.ts"), "utf8");
assert.ok(ipcProtocolSource.replaceAll(/\s/g, "").includes(`exportconstallowedAgentLifecycleStates=${JSON.stringify(lifecycleContract.states)}asconst;`), "Desktop lifecycle states drifted from the release contract.");
const bridgeCoreSource = readFileSync(join(bridgeRoot, "scripts", "bridge-core.mjs"), "utf8");
assert.ok(Array.isArray(bridgeContract.emittedStates) && bridgeContract.emittedStates.length > 0, "Bridge must declare the lifecycle states it can actually emit.");
for (const state of bridgeContract.emittedStates) {
  assert.ok(lifecycleContract.states.includes(state), `Bridge declares unsupported lifecycle state ${state}.`);
  assert.match(bridgeCoreSource, new RegExp(`\\b${state}\\b`), `Bridge lifecycle mapping is missing ${state}.`);
}
const nativeHookSource = readFileSync(join(root, "native", "brainpet-hook", "src", "main.rs"), "utf8");
for (const state of lifecycleContract.states) assert.match(nativeHookSource, new RegExp(`"${state}"`), `Native lifecycle mapping is missing ${state}.`);
const cargo = readFileSync(join(root, "native", "brainpet-hook", "Cargo.toml"), "utf8");
assert.match(cargo, new RegExp(`^version = "${brainPetDistributionContract.bridge.version.replaceAll(".", "\\.")}"$`, "m"));
const installationStateSource = readFileSync(join(desktop, "src", "brainpet-installation-state.ts"), "utf8");
assert.match(installationStateSource, new RegExp(`brainPetBridgeVersion = "${brainPetDistributionContract.bridge.version.replaceAll(".", "\\.")}"`));

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
