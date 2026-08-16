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
assert.match(baseConfig, /\.brainpet-package\/marketplace/);
assert.match(privateConfig, /dist-brainpet\/private-test/);
assert.match(privateConfig, /signAndEditExecutable: false/);
assert.match(publicConfig, /dist-brainpet\/public-release/);
assert.match(publicConfig, /BrainPet-Unsigned-/);
assert.match(publicConfig, /identity: null/);
assert.match(publicConfig, /hardenedRuntime: false/);
assert.match(publicConfig, /gatekeeperAssess: false/);
assert.match(publicConfig, /notarize: false/);
assert.match(publicConfig, /signAndEditExecutable: false/);
assert.match(publicConfig, /verifyUpdateCodeSignature: false/);
assert.equal(brainPetDistributionContract.identity.appId, "dev.brainpet.app");
assert.equal(brainPetDistributionContract.identity.executableName, "brainpet");
assert.equal(brainPetDistributionContract.schemaVersion, 2);
assert.deepEqual(brainPetDistributionContract.releasePolicy, {
  channel: "direct-download",
  platformSignatureStatus: "absent-by-policy",
  userConsentRequired: true,
  storeRegistrationRequired: false,
  publisherRegistrationRequired: false,
  provenance: "sigstore-keyless",
});
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
assert.match(optionalServicesSource, /startPluginPlatformTransaction/, "Optional OpenPets plugin startup must roll back partially acquired resources before retry.");
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
assert.match(readFileSync(join(desktop, "build", "brainpet-installer.nsh"), "utf8"), /runtime-install\.json\.bak/);
assert.ok(existsSync(join(desktop, "scripts", "validate-brainpet-package.mjs")));
assert.match(readFileSync(join(desktop, "scripts", "brainpet-package.mjs"), "utf8"), /prepareBrainPetBundledMarketplace/);
assert.match(readFileSync(join(desktop, "scripts", "brainpet-package.mjs"), "utf8"), /validateBrainPetPackage/, "Default BrainPet packaging must automatically invoke the real package validator.");
assert.match(readFileSync(join(desktop, "scripts", "validate-brainpet-package.mjs"), "utf8"), /nativeBridgeHelpersBundled: true/);
assert.ok(existsSync(join(desktop, "scripts", "brainpet-package-lifecycle.mjs")));
assert.ok(existsSync(join(root, "scripts", "aggregate-brainpet-release-receipt.mjs")));
assert.match(readFileSync(join(root, "integrations", "codex", "scripts", "assemble-bridge-release.mjs"), "utf8"), /closure: createBridgeArtifactClosure/);
assert.match(readFileSync(join(root, "integrations", "codex", "scripts", "validate-bridge-release.mjs"), "utf8"), /validateBridgeArtifactClosure/);
const sigstoreSource = readFileSync(join(root, "scripts", "brainpet-sigstore-provenance.mjs"), "utf8");
assert.match(sigstoreSource, /--certificate-github-workflow-repository/);
assert.match(sigstoreSource, /--certificate-github-workflow-sha/);
assert.match(sigstoreSource, /RUNNER_ENVIRONMENT/);
assert.match(sigstoreSource, /brainpet-physical-receipt-intake\.yml/);
const publicReleaseWorkflow = readFileSync(join(root, ".github", "workflows", "brainpet-public-release-gate.yml"), "utf8");
assert.match(publicReleaseWorkflow, /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/);
assert.match(publicReleaseWorkflow, /brainpet-public-provenance/);
assert.match(publicReleaseWorkflow, /stage-brainpet-package-artifacts\.mjs/);
assert.match(publicReleaseWorkflow, /brainpet-public-runtime-current-/);
assert.match(publicReleaseWorkflow, /brainpet-lifecycle-fixture-/);
assert.doesNotMatch(publicReleaseWorkflow, /path:\s*apps\/desktop\/dist-brainpet\/public-release\/?\s*$/m, "Public artifacts must be uploaded from a strict staged allowlist.");
assert.match(publicReleaseWorkflow, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
assert.doesNotMatch(publicReleaseWorkflow, /BRAINPET_(?:WIN|MAC)|WIN_CSC|CSC_LINK|CSC_KEY_PASSWORD|APPLE_ID|APPLE_TEAM_ID|APPLE_APP_SPECIFIC_PASSWORD/);
assert.doesNotMatch(publicReleaseWorkflow, /--defer-trust/);
assert.doesNotMatch(publicReleaseWorkflow, /actions\/attest|gh attestation/, "Private-repository RC6 must not depend on GitHub Artifact Attestations.");
const portabilityWorkflow = readFileSync(join(root, ".github", "workflows", "brainpet-portability-gate.yml"), "utf8");
for (const [name, source] of [["portability", portabilityWorkflow], ["public release", publicReleaseWorkflow]]) {
  assert.match(source, /pnpm --filter @open-pets\/desktop\.\.\. install --frozen-lockfile/, `BrainPet ${name} runtime jobs must exclude unrelated root-only dependencies on Windows ARM64.`);
}
assert.match(portabilityWorkflow, /source-contract:[\s\S]*?pnpm install --frozen-lockfile[\s\S]*?pnpm brainpet:release:test/, "The portability source-contract job must still install and test the complete workspace.");
for (const [name, source] of [["portability", portabilityWorkflow], ["public release", publicReleaseWorkflow]]) {
  const pnpmSetupCount = source.match(/pnpm\/action-setup@v4/g)?.length ?? 0;
  const compatibleNodeSetupCount = source.match(/node-version:\s*22\b/g)?.length ?? 0;
  assert.ok(pnpmSetupCount > 0, `BrainPet ${name} workflow must install pnpm explicitly.`);
  assert.equal(compatibleNodeSetupCount, pnpmSetupCount, `BrainPet ${name} workflow must run pnpm 11 on Node 22.`);
  assert.doesNotMatch(source, /node-version:\s*20\b/, `BrainPet ${name} workflow must not pair pnpm 11 with incompatible Node 20.`);
}
assert.ok(existsSync(join(root, ".github", "workflows", "brainpet-physical-receipt-intake.yml")));
assert.ok(existsSync(join(root, ".github", "workflows", "brainpet-public-release-finalize.yml")));
const physicalIntakeWorkflow = readFileSync(join(root, ".github", "workflows", "brainpet-physical-receipt-intake.yml"), "utf8");
const publicFinalizeWorkflow = readFileSync(join(root, ".github", "workflows", "brainpet-public-release-finalize.yml"), "utf8");
for (const [name, source] of [["physical intake", physicalIntakeWorkflow], ["public finalize", publicFinalizeWorkflow]]) {
  assert.doesNotMatch(source, /^\s*run:.*\$\{\{\s*inputs\./m, `BrainPet ${name} must not interpolate workflow_dispatch inputs into shell source.`);
  for (const line of source.split(/\r?\n/).filter((candidate) => candidate.includes("${{ inputs."))) {
    assert.match(line, /^\s+BRAINPET_[A-Z0-9_]+:\s*\$\{\{\s*inputs\.[a-z0-9_]+\s*\}\}\s*$/, `BrainPet ${name} workflow_dispatch inputs must only enter fixed BRAINPET_* environment variables.`);
  }
}
assert.match(physicalIntakeWorkflow, /candidate_run_id/);
assert.match(physicalIntakeWorkflow, /BRAINPET_CANDIDATE_RUN_ID: \$\{\{ inputs\.candidate_run_id \}\}/);
assert.match(physicalIntakeWorkflow, /environment: brainpet-physical-acceptance/);
assert.match(physicalIntakeWorkflow, /actions\/runs\/\$\{GITHUB_RUN_ID\}\/approvals/);
assert.match(physicalIntakeWorkflow, /--candidate-receipt output\/candidate\/candidate-receipt\/brainpet-release-receipt\.json/);
assert.match(physicalIntakeWorkflow, /--approval-history output\/approval-history\.json/);
const physicalIntakeSource = readFileSync(join(root, "scripts", "intake-brainpet-physical-receipts.mjs"), "utf8");
const physicalDownloadSource = readFileSync(join(root, "scripts", "download-brainpet-physical-receipts.mjs"), "utf8");
assert.match(physicalIntakeSource, /environmentApprovalComment/);
assert.match(physicalIntakeSource, /receipts-payload-sha256=/);
assert.match(physicalIntakeSource, /GITHUB_RUN_ATTEMPT, "1"/);
assert.match(physicalDownloadSource, /assert\.equal\(String\(run\.run_attempt\), "1"/);
assert.match(physicalDownloadSource, /validateEnvironmentApprovalHistory/);
assert.match(readFileSync(join(root, "scripts", "aggregate-brainpet-release-receipt.mjs"), "utf8"), /assert\.equal\(String\(intake\.github\?\.runAttempt\), "1"/);
assert.match(physicalIntakeWorkflow, /brainpet-sigstore-provenance\.mjs/);
assert.match(physicalIntakeWorkflow, /output\/sealed\/provenance/);
assert.match(publicFinalizeWorkflow, /--physical-provenance output\/physical\/provenance/);
assert.match(publicFinalizeWorkflow, /BRAINPET_CANDIDATE_RUN_ID: \$\{\{ inputs\.candidate_run_id \}\}/);
assert.match(publicFinalizeWorkflow, /BRAINPET_PHYSICAL_RECEIPT_RUN_ID: \$\{\{ inputs\.physical_receipt_run_id \}\}/);
const packageValidatorSource = readFileSync(join(desktop, "scripts", "validate-brainpet-package.mjs"), "utf8");
assert.match(packageValidatorSource, /assertMacosCodeObjectIsUnsigned/);
assert.match(packageValidatorSource, /--appimage-signature/);
assert.match(packageValidatorSource, /deb unexpectedly contains an embedded signature or non-standard archive member/);
assert.deepEqual(Object.fromEntries(brainPetDistributionContract.releaseTargets.map((target) => [target.id, target.supportLevel])), {
  "windows-x64": "stable",
  "windows-arm64": "preview",
  "macos-x64": "beta",
  "macos-arm64": "stable",
  "linux-x64": "beta",
  "linux-arm64": "preview",
});
assert.match(JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).scripts["test:brainpet-openpets-isolation"], /BRAINPET_EXPECT_OPENPETS_ISOLATION=1/);

const bridgeRoot = join(root, "integrations", "codex", "plugins", "brainpet-codex-bridge");
const bridgeContract = JSON.parse(readFileSync(join(bridgeRoot, "brainpet.bridge.json"), "utf8"));
assert.deepEqual(bridgeContract.releaseTargets, brainPetReleaseTargetIds);
assert.equal(bridgeContract.bridgeVersion, brainPetDistributionContract.bridge.version);
assert.equal(bridgeContract.minimumRuntimeIpcVersion, brainPetDistributionContract.bridge.minimumRuntimeIpcVersion);
assert.equal(bridgeContract.hookDeadlineMs, brainPetDistributionContract.bridge.hookDeadlineMs);
assert.equal(bridgeContract.connectAttemptMs, brainPetDistributionContract.bridge.connectAttemptMs);
assert.deepEqual(bridgeContract.transportPriority, ["native-hook"]);
assert.match(readFileSync(join(bridgeRoot, "scripts", "bridge.sh"), "utf8"), /Linux\) platform="linux"/);
for (const launcher of ["bridge.cmd", "bridge.sh"]) assert.doesNotMatch(readFileSync(join(bridgeRoot, "scripts", launcher), "utf8"), /\b(?:node|npm|npx|pnpm)\b\s+["']?[^\r\n]*bridge\.mjs/i);
assert.ok(existsSync(join(root, "integrations", "codex", ".agents", "plugins", "marketplace.json")));
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
const installMarkerSource = readFileSync(join(desktop, "src", "brainpet-install-marker.ts"), "utf8");
const generatedDistributionSource = readFileSync(join(desktop, "src", "generated-brainpet-distribution.ts"), "utf8");
assert.match(generatedDistributionSource, new RegExp(`brainPetBridgeVersion = "${brainPetDistributionContract.bridge.version.replaceAll(".", "\\.")}"`));
assert.match(generatedDistributionSource, /brainPetReleasePolicy/);
assert.match(installationStateSource, /from "\.\/generated-brainpet-distribution\.js"/, "Installation evidence must consume the generated Bridge version.");
const adapterManagerSource = readFileSync(join(desktop, "src", "brainpet-adapter-manager.ts"), "utf8");
assert.match(adapterManagerSource, /plugin", "marketplace", "add"/, "BrainPet one-click setup must add the bundled marketplace through Codex CLI.");
assert.match(adapterManagerSource, /plugin", "remove"/, "BrainPet one-click setup must support Bridge removal through Codex CLI.");
assert.match(adapterManagerSource, /backupConfig/, "BrainPet adapter mutations must create an atomic config backup.");
assert.match(adapterManagerSource, /rollbackApplied/, "BrainPet adapter mutations must report rollback evidence.");
assert.doesNotMatch(adapterManagerSource, /config\.toml[^\n]*(?:writeFileSync|appendFileSync)/, "BrainPet setup must not directly edit Codex config.");
const setupPreloadSource = readFileSync(join(desktop, "brainpet-setup-preload.cjs"), "utf8");
for (const api of ["getAdapterStatus", "connectCodex", "disconnectCodex"]) assert.match(setupPreloadSource, new RegExp(api), `BrainPet setup preload must expose ${api}.`);
assert.match(installMarkerSource, /`\$\{path\}\.bak`/, "BrainPet runtime must maintain a marker recovery copy.");
assert.ok(existsSync(join(desktop, "scripts", "brainpet-single-instance-smoke.mjs")));
assert.ok(existsSync(join(desktop, "scripts", "brainpet-adapter-ui-smoke.mjs")));

assertBrainPetProviderMatrixCurrent();
const automaticProviderIds = adapterRegistry.providers.filter((provider) => provider.automaticLifecycle).map((provider) => provider.id);
assert.deepEqual(automaticProviderIds, ["codex", "claude", "opencode"]);
assert.equal(bridgeContract.provider, "codex");
assert.match(bridgeCoreSource, /agent:\s*"codex"/);
assert.match(readFileSync(join(root, "packages", "claude", "src", "hooks.ts"), "utf8"), /agent:\s*"claude"/);
assert.match(readFileSync(join(root, "packages", "opencode", "src", "opencode-plugin-runtime.ts"), "utf8"), /agent:\s*"opencode"/);
console.log(`BrainPet release source validation passed (${brainPetReleaseTargetIds.length} targets, ${adapterRegistry.providers.length} providers).`);
