#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract, brainPetReleaseTargetIds } from "./brainpet-release-contract.mjs";
import { assertBrainPetProviderMatrixCurrent } from "./generate-brainpet-provider-matrix.mjs";
import { assertBrainPetAdapterContractsCurrent } from "./generate-brainpet-adapter-contracts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assertBrainPetAdapterContractsCurrent();
const desktop = join(root, "apps", "desktop");
const lifecycleContract = JSON.parse(readFileSync(join(root, "config", "brainpet-agent-lifecycle.json"), "utf8"));
const releaseCapabilities = JSON.parse(readFileSync(join(root, "config", "brainpet-release-capabilities.json"), "utf8"));
const adapterRegistry = JSON.parse(readFileSync(join(root, "config", "brainpet-adapter-registry.json"), "utf8"));
const workspacePackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.match(workspacePackage.scripts.check, /brainpet:adapters:check/, "Default check must include adapter conformance.");
assert.match(workspacePackage.scripts["brainpet:release:test"], /brainpet:adapters:check/, "Release test must include adapter conformance.");
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
assert.deepEqual(releaseCapabilities.productIds, ["openpets", "brainpet"]);
assert.deepEqual(Object.keys(releaseCapabilities.runtimeSnapshots.openpets), releaseCapabilities.capabilityIds);
assert.deepEqual(Object.keys(releaseCapabilities.runtimeSnapshots.brainpetEnabled), releaseCapabilities.capabilityIds);
assert.deepEqual(Object.keys(releaseCapabilities.runtimeSnapshots.brainpetRollback), releaseCapabilities.capabilityIds);
assert.deepEqual(releaseCapabilities.runtimeSnapshots.brainpetEnabled, {
  agentLifecycle: true,
  brainPetHost: true,
  brainPetInstallMarker: true,
  brainPetOnboarding: true,
  controlCenter: false,
  lan: false,
  localIpc: true,
  openPetsAgentSetup: false,
  pluginPlatform: false,
  remoteControl: false,
  voice: false,
});
assert.equal(releaseCapabilities.runtimeSnapshots.brainpetRollback.agentLifecycle, false);
const compositionSource = readFileSync(join(desktop, "src", "composition", "desktop-composition.ts"), "utf8");
const mainSource = readFileSync(join(desktop, "src", "main.ts"), "utf8");
const lifecycleSource = readFileSync(join(desktop, "src", "lifecycle.ts"), "utf8");
const managedServiceSource = readFileSync(join(desktop, "src", "composition", "managed-service.ts"), "utf8");
const optionalServicesSource = readFileSync(join(desktop, "src", "composition", "openpets-runtime.ts"), "utf8");
const defaultPetControllerSource = readFileSync(join(desktop, "src", "default-pet-controller.ts"), "utf8");
const brainPetHostSource = readFileSync(join(desktop, "src", "brainpet", "host.ts"), "utf8");
const brainPetControllerSources = Object.fromEntries([
  "training-entry",
  "stage-window-controller",
  "session-authority",
  "interaction-rig-controller",
].map((name) => [name, readFileSync(join(desktop, "src", "brainpet", `${name}.ts`), "utf8")]));
const distributionSource = readFileSync(join(desktop, "src", "distribution-profile.ts"), "utf8");
assert.match(compositionSource, /layers: enabled \? \["hostCore", "brainPetFeature"\] : \["hostCore"\]/, "BrainPet must not compose OptionalOpenPetsServices.");
assert.match(mainSource, /import\("\.\/composition\/openpets-runtime\.js"\)/, "Optional OpenPets services must be dynamically loaded.");
assert.match(mainSource, /if \(distribution\.profile === "brainpet"\) app\.disableHardwareAcceleration\(\);/, "BrainPet must avoid the dedicated hardware compositor working set without changing OpenPets.");
assert.doesNotMatch(lifecycleSource, /plugin-service|brainpet\/host|remote-control-service|lan-controller|local-ipc|windows\.js/, "App lifecycle must only call the composition disposer.");
assert.match(managedServiceSource, /#disposeRequested/, "Composition lifecycle must stop factory creation once disposal begins.");
assert.match(optionalServicesSource, /AsyncOperationGate/, "Optional OpenPets services must drain lazy work before disposal completes.");
assert.match(optionalServicesSource, /runResourceTransaction/, "Optional OpenPets plugin startup must roll back partially acquired resources before retry.");
assert.doesNotMatch(defaultPetControllerSource, /^import .*lan-pet-controller/m, "HostCore must not statically load the LAN pet implementation.");
assert.doesNotMatch(brainPetHostSource, /brainpet\.training|plugin-service|plugin-runtime|plugin-events-source/, "BrainPet TrainingEntry must not use the removed plugin facade.");
for (const [name, source] of Object.entries(brainPetControllerSources)) {
  assert.match(source, /\bdispose\(\)/, `BrainPet ${name} must expose an independent disposer.`);
  assert.match(brainPetHostSource, new RegExp(name.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("")), `BrainPet Host must compose ${name}.`);
}
assert.doesNotMatch(brainPetHostSource, /canonicalizeBrainPetTaskResult|getBrainPetTaskDefinition|trialKindsForSession|createBrainPetInteractionRig|reanchorBrainPetInteractionRig|reflowBrainPetInteractionRig|translateBrainPetStageInRig/, "BrainPet Host aggregate must not own task rules or interaction-rig geometry.");
assert.doesNotMatch(distributionSource, /brainpet\.training/, "BrainPet must not seed a training plugin.");
assert.doesNotMatch(baseConfig, /plugins\/official|plugin-sdk-preload|plugin-command-form-preload|panel-preload/, "BrainPet package must not bundle plugin renderer payloads.");
assert.match(readFileSync(join(desktop, "build", "brainpet-installer.nsh"), "utf8"), /runtime-install\.json/);
assert.ok(existsSync(join(desktop, "scripts", "validate-brainpet-package.mjs")));
assert.match(JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).scripts["test:brainpet-openpets-isolation"], /BRAINPET_EXPECT_OPENPETS_ISOLATION=1/);

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
assert.match(ipcProtocolSource, /allowedAgentLifecycleStates\s*=\s*normalizedAgentLifecycleStates/, "Desktop lifecycle states must consume the generated release contract.");
const bridgeCoreSource = readFileSync(join(bridgeRoot, "scripts", "bridge-core.mjs"), "utf8");
assert.ok(Array.isArray(bridgeContract.emittedStates) && bridgeContract.emittedStates.length > 0, "Bridge must declare the lifecycle states it can actually emit.");
for (const state of bridgeContract.emittedStates) {
  assert.ok(lifecycleContract.states.includes(state), `Bridge declares unsupported lifecycle state ${state}.`);
  assert.match(bridgeCoreSource, new RegExp(`\\b${state}\\b`), `Bridge lifecycle mapping is missing ${state}.`);
}
const nativeHookSource = readFileSync(join(root, "native", "brainpet-hook", "src", "main.rs"), "utf8");
const nativeGeneratedContract = readFileSync(join(root, "native", "brainpet-hook", "src", "generated_contract.rs"), "utf8");
for (const state of lifecycleContract.states) assert.match(`${nativeHookSource}\n${nativeGeneratedContract}`, new RegExp(`"${state}"`), `Native lifecycle mapping is missing ${state}.`);
const cargo = readFileSync(join(root, "native", "brainpet-hook", "Cargo.toml"), "utf8");
assert.match(cargo, new RegExp(`^version = "${brainPetDistributionContract.bridge.version.replaceAll(".", "\\.")}"$`, "m"));
const installationStateSource = readFileSync(join(desktop, "src", "brainpet-installation-state.ts"), "utf8");
assert.match(installationStateSource, new RegExp(`brainPetBridgeVersion = "${brainPetDistributionContract.bridge.version.replaceAll(".", "\\.")}"`));

assertBrainPetProviderMatrixCurrent();
const automaticProviderIds = adapterRegistry.providers.filter((provider) => provider.automaticLifecycle).map((provider) => provider.id);
assert.deepEqual(automaticProviderIds, ["codex", "claude", "opencode"]);
assert.equal(bridgeContract.provider, "codex");
assert.match(bridgeCoreSource, /agent:\s*"codex"/);
assert.match(readFileSync(join(root, "packages", "claude", "src", "hooks.ts"), "utf8"), /agent:\s*"claude"/);
assert.match(readFileSync(join(root, "packages", "opencode", "src", "opencode-plugin-runtime.ts"), "utf8"), /agent:\s*"opencode"/);
console.log(`BrainPet release source validation passed (${brainPetReleaseTargetIds.length} targets, ${adapterRegistry.providers.length} providers).`);
