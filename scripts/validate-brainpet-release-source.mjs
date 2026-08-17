#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

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
assert.match(workspacePackage.scripts["brainpet:idle-gate:start"], /brainpet:idle-gate:start/, "Workspace must expose the detached 24-hour idle gate runner.");
assert.match(workspacePackage.scripts["brainpet:idle-gate:status"], /brainpet:idle-gate:status/, "Workspace must expose detached idle gate status.");
assert.match(workspacePackage.scripts["brainpet:performance:candidate:prepare"], /prepare-brainpet-public-performance-candidate\.mjs/, "Workspace must expose exact public performance-candidate preparation.");
const baseConfig = readFileSync(join(desktop, "electron-builder.brainpet.base.yml"), "utf8");
const privateConfig = readFileSync(join(desktop, "electron-builder.brainpet.private.yml"), "utf8");
const publicConfig = readFileSync(join(desktop, "electron-builder.brainpet.public.yml"), "utf8");
const macosSignatureHook = readFileSync(join(desktop, "scripts", "brainpet-strip-macos-signatures.cjs"), "utf8");
const packageLifecycleSource = readFileSync(join(desktop, "scripts", "brainpet-package-lifecycle.mjs"), "utf8");
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
assert.match(publicConfig, /afterPack:\s+scripts\/brainpet-strip-macos-signatures\.cjs/);
assert.match(macosSignatureHook, /--remove-signature/);
assert.match(macosSignatureHook, /\["--force", "--sign", "-", candidate\]/, "macOS packaging must replace inherited identities with certificate-free ad-hoc signatures.");
assert.match(macosSignatureHook, /Signature=adhoc/);
assert.match(macosSignatureHook, /machOMagic[\s\S]*isMachOFile[\s\S]*isMachOFile\(candidate\)/, "macOS packaging must include initially unsigned extensionless Mach-O executables in the ad-hoc closure.");
assert.match(macosSignatureHook, /\["--verify", "--deep", "--strict", appBundle\]/, "macOS packaging must validate the complete ad-hoc app signature closure.");
assert.match(macosSignatureHook, /refreshBundledHelperReceipt/, "macOS packaging must rebind the bundled helper receipt after ad-hoc signing changes its bytes.");
assert.match(macosSignatureHook, /code object is not signed at all/);
assert.match(macosSignatureHook, /isSymbolicLink\(\)\) return/);
assert.match(packageLifecycleSource, /stageLifecycleAppImageForExtraction/);
assert.match(packageLifecycleSource, /apt-get", "install/);
assert.match(packageLifecycleSource, /removeOwnedLifecycleDiscovery/);
assert.match(packageLifecycleSource, /await uninstallArtifact/);
assert.match(packageLifecycleSource, /await waitForMissing\(paths\.executable, 30_000\)/, "NSIS lifecycle must wait for the asynchronous uninstaller to remove the exact executable.");
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
assert.match(mainSource, /distribution\.profile === "brainpet" && process\.platform === "win32"[\s\S]*app\.disableHardwareAcceleration\(\)/, "Windows BrainPet must use software composition without moving the GPU service into the browser process.");
assert.doesNotMatch(mainSource, /in-process-gpu|appendSwitch\("(?:use-angle|use-gl|disable-gpu-rasterization|enable-gpu-rasterization|use-vulkan)"|swiftshader/i, "BrainPet must retain Chromium's separate GPU crash boundary and must not select a custom GPU backend.");
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
assert.match(sigstoreSource, /brainpet-performance-receipt-intake\.yml/);
const publicReleaseWorkflow = readFileSync(join(root, ".github", "workflows", "brainpet-public-release-gate.yml"), "utf8");
assert.match(publicReleaseWorkflow, /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/);
assert.match(publicReleaseWorkflow, /brainpet-public-provenance/);
assert.match(publicReleaseWorkflow, /stage-brainpet-package-artifacts\.mjs/);
assert.match(publicReleaseWorkflow, /brainpet-public-runtime-current-/);
assert.match(publicReleaseWorkflow, /brainpet-lifecycle-fixture-/);
assert.match(publicReleaseWorkflow, /name:\s*brainpet-public-bridge\r?\n\s+path:\s*output\/bridge\r?\n\s+include-hidden-files:\s*true/, "Public Bridge artifact must preserve .codex-plugin and every other hidden release entry.");
assert.doesNotMatch(publicReleaseWorkflow, /path:\s*apps\/desktop\/dist-brainpet\/public-release\/?\s*$/m, "Public artifacts must be uploaded from a strict staged allowlist.");
assert.match(publicReleaseWorkflow, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
assert.doesNotMatch(publicReleaseWorkflow, /BRAINPET_(?:WIN|MAC)|WIN_CSC|CSC_LINK|CSC_KEY_PASSWORD|APPLE_ID|APPLE_TEAM_ID|APPLE_APP_SPECIFIC_PASSWORD/);
assert.doesNotMatch(publicReleaseWorkflow, /--defer-trust/);
assert.doesNotMatch(publicReleaseWorkflow, /actions\/attest|gh attestation/, "Private-repository RC6 must not depend on GitHub Artifact Attestations.");
const portabilityWorkflow = readFileSync(join(root, ".github", "workflows", "brainpet-portability-gate.yml"), "utf8");
assert.match(portabilityWorkflow, /^on:\r?\n\s+workflow_dispatch:\s*$/m, "Six-target portability must remain an explicit RC-boundary dispatch.");
assert.doesNotMatch(portabilityWorkflow, /^\s+(?:push|pull_request|schedule):/m, "Daily Git activity must not trigger six-target portability packaging.");
assert.match(publicReleaseWorkflow, /^on:\r?\n\s+workflow_dispatch:\s*$/m, "Public candidate packaging must remain an explicit RC-boundary dispatch.");
assert.doesNotMatch(publicReleaseWorkflow, /^\s+(?:push|pull_request|schedule):/m, "Daily Git activity must not trigger public candidate packaging.");
assert.match(portabilityWorkflow, /name:\s*brainpet-codex-bridge\r?\n\s+path:\s*output\/brainpet-release\/brainpet-codex-bridge\r?\n\s+include-hidden-files:\s*true/, "Private Bridge artifact must preserve .codex-plugin and every other hidden release entry.");
for (const [name, source] of [["portability", portabilityWorkflow], ["public release", publicReleaseWorkflow]]) {
  assert.match(source, /pnpm --filter @open-pets\/desktop\.\.\. install --frozen-lockfile --ignore-scripts/, `BrainPet ${name} runtime jobs must install without executing unrelated root-only build scripts.`);
  assert.match(source, /pnpm --filter @open-pets\/desktop\.\.\. rebuild esbuild get-windows sharp/, `BrainPet ${name} runtime jobs must rebuild the exact desktop native dependency allowlist.`);
  assert.doesNotMatch(source, /pnpm --filter @open-pets\/desktop\.\.\. rebuild[^\r\n]*workerd/, `BrainPet ${name} runtime jobs must not execute the unsupported root-only workerd build on Windows ARM64.`);
}
assert.match(portabilityWorkflow, /source-contract:[\s\S]*?pnpm install --frozen-lockfile[\s\S]*?pnpm brainpet:release:test/, "The portability source-contract job must still install and test the complete workspace.");
assert.match(portabilityWorkflow, /runner\.os == 'Linux'[\s\S]*?xvfb-run -a node apps\/desktop\/scripts\/brainpet-package-lifecycle\.mjs/, "Linux installer lifecycle and helper cold wake must share one Xvfb session.");
assert.match(portabilityWorkflow, /runner\.os != 'Linux'[\s\S]*?node apps\/desktop\/scripts\/brainpet-package-lifecycle\.mjs/, "Windows and macOS installer lifecycle must run the same production script without Xvfb.");
assert.match(publicReleaseWorkflow, /runner\.os == 'Linux'[\s\S]*?xvfb-run -a node apps\/desktop\/scripts\/brainpet-package-lifecycle\.mjs/, "Public Linux installer lifecycle and helper cold wake must share one Xvfb session.");
assert.match(publicReleaseWorkflow, /runner\.os != 'Linux'[\s\S]*?node apps\/desktop\/scripts\/brainpet-package-lifecycle\.mjs/, "Public Windows and macOS installer lifecycle must run the same production script without Xvfb.");
assert.match(portabilityWorkflow, /brainpet-ci-runtime-archive\.mjs create --source apps\/desktop\/dist-brainpet\/private-test --archive output\/brainpet-runtime-current-\$\{\{ matrix\.id \}\}\.tar[\s\S]*?path: output\/brainpet-runtime-current-\$\{\{ matrix\.id \}\}\.tar/, "Private current runtimes must cross the artifact boundary inside a tar archive that preserves links, modes, and hidden files.");
assert.match(portabilityWorkflow, /brainpet-ci-runtime-archive\.mjs create --source apps\/desktop\/dist-brainpet\/upgrade-fixture-\$\{\{ matrix\.id \}\} --archive output\/brainpet-upgrade-fixture-\$\{\{ matrix\.id \}\}\.tar[\s\S]*?path: output\/brainpet-upgrade-fixture-\$\{\{ matrix\.id \}\}\.tar/, "Private upgrade runtimes must cross the artifact boundary inside a tar archive that preserves links, modes, and hidden files.");
assert.doesNotMatch(portabilityWorkflow, /path: apps\/desktop\/dist-brainpet\/(?:private-test|upgrade-fixture-)/, "Private unpacked runtime directories must not cross the GitHub artifact boundary without tar transport.");
assert.match(portabilityWorkflow, /brainpet-ci-runtime-archive\.mjs extract --archive output\/current-archive\/brainpet-runtime-current-\$\{\{ matrix\.id \}\}\.tar --output output\/current/, "Lifecycle jobs must restore the exact current private runtime before validation.");
assert.match(portabilityWorkflow, /brainpet-ci-runtime-archive\.mjs extract --archive output\/previous-archive\/brainpet-upgrade-fixture-\$\{\{ matrix\.id \}\}\.tar --output output\/previous/, "Lifecycle jobs must restore the exact previous private runtime before validation.");
assert.match(portabilityWorkflow, /pattern: brainpet-runtime-current-\*[\s\S]*?merge-multiple: true[\s\S]*?brainpet-ci-runtime-archive\.mjs extract-all --archives output\/package-archives --output output\/packages/, "Private receipt aggregation must restore the exact six-runtime archive set before tree validation.");
assert.match(publicReleaseWorkflow, /path: output\/public-runtime-current-\$\{\{ matrix\.id \}\}\/\r?\n\s+include-hidden-files: true/, "Public current runtime artifacts must preserve hidden marketplace files.");
assert.match(publicReleaseWorkflow, /path: output\/lifecycle-fixture-\$\{\{ matrix\.id \}\}\/\r?\n\s+include-hidden-files: true/, "Public upgrade runtime artifacts must preserve hidden marketplace files.");
for (const [name, source] of [["portability", portabilityWorkflow], ["public release", publicReleaseWorkflow]]) {
  const pnpmSetupCount = source.match(/pnpm\/action-setup@[a-f0-9]{40}/g)?.length ?? 0;
  const compatibleNodeSetupCount = source.match(/node-version:\s*22\b/g)?.length ?? 0;
  assert.ok(pnpmSetupCount > 0, `BrainPet ${name} workflow must install pnpm explicitly.`);
  assert.equal(compatibleNodeSetupCount, pnpmSetupCount, `BrainPet ${name} workflow must run pnpm 11 on Node 22.`);
  assert.doesNotMatch(source, /node-version:\s*20\b/, `BrainPet ${name} workflow must not pair pnpm 11 with incompatible Node 20.`);
}
assert.ok(existsSync(join(root, ".github", "workflows", "brainpet-physical-receipt-intake.yml")));
assert.ok(existsSync(join(root, ".github", "workflows", "brainpet-performance-receipt-intake.yml")));
assert.ok(existsSync(join(root, ".github", "workflows", "brainpet-public-release-finalize.yml")));
const physicalIntakeWorkflow = readFileSync(join(root, ".github", "workflows", "brainpet-physical-receipt-intake.yml"), "utf8");
const performanceIntakeWorkflow = readFileSync(join(root, ".github", "workflows", "brainpet-performance-receipt-intake.yml"), "utf8");
const publicFinalizeWorkflow = readFileSync(join(root, ".github", "workflows", "brainpet-public-release-finalize.yml"), "utf8");
for (const [name, source] of [["portability", portabilityWorkflow], ["public release", publicReleaseWorkflow], ["physical intake", physicalIntakeWorkflow], ["performance intake", performanceIntakeWorkflow], ["public finalize", publicFinalizeWorkflow]]) assertExactWorkflowPins(name, source);
for (const [name, fixture] of [
  ["job-level", "jobs:\n  delegated:\n    uses: owner/repository/.github/workflows/reusable.yml@main\n"],
  ["quoted-key", "jobs:\n  delegated:\n    \"uses\": owner/repository/.github/workflows/reusable.yml@main\n"],
  ["flow-mapping", "steps:\n  - { uses: owner/action@main }\n"],
  ["tagged-key", "steps:\n  - !!map\n    !!str uses: owner/action@main\n"],
  ["anchored-key", "steps:\n  - &step\n    &uses-key uses: owner/action@main\n"],
]) assert.throws(() => assertExactWorkflowPins(`${name} regression fixture`, fixture), /exact 40-character commit/, `${name} workflow syntax must not bypass exact action pinning.`);

function assertExactWorkflowPins(name, source) {
  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: false });
  assert.equal(document.errors.length, 0, `BrainPet ${name} workflow YAML is invalid: ${document.errors[0]?.message ?? "unknown parse error"}`);
  assert.equal(document.warnings.length, 0, `BrainPet ${name} workflow YAML has an unsafe warning: ${document.warnings[0]?.message ?? "unknown warning"}`);
  const actionReferences = [];
  collectWorkflowUses(document.toJS({ mapAsMap: true, maxAliasCount: 100 }), actionReferences);
  assert.ok(actionReferences.length > 0, `BrainPet ${name} workflow must use at least one pinned action.`);
  for (const reference of actionReferences) {
    assert.equal(typeof reference, "string", `BrainPet ${name} workflow action reference must be a scalar string.`);
    assert.match(reference, /^[^@\s]+@[a-f0-9]{40}$/, `BrainPet ${name} workflow action must be pinned to an exact 40-character commit: ${String(reference)}`);
  }
}

function collectWorkflowUses(value, references) {
  if (value instanceof Map) {
    for (const [key, child] of value) {
      if (key === "uses") references.push(child);
      collectWorkflowUses(child, references);
    }
  } else if (Array.isArray(value)) {
    for (const child of value) collectWorkflowUses(child, references);
  }
}
for (const [name, source] of [["physical intake", physicalIntakeWorkflow], ["performance intake", performanceIntakeWorkflow], ["public finalize", publicFinalizeWorkflow]]) {
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
assert.match(performanceIntakeWorkflow, /environment: brainpet-physical-acceptance/);
assert.match(performanceIntakeWorkflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
assert.match(performanceIntakeWorkflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
assert.doesNotMatch(performanceIntakeWorkflow, /actions\/(?:checkout|upload-artifact)@v\d/);
assert.match(performanceIntakeWorkflow, /BRAINPET_PERFORMANCE_RECEIPTS_GZIP_BASE64: \$\{\{ inputs\.receipts_gzip_base64 \}\}/);
assert.match(performanceIntakeWorkflow, /--candidate-package output\/candidate\/packages\/brainpet-public-runtime-current-windows-x64 --candidate-provenance output\/candidate\/provenance/, "Protected performance intake must receive the official package and provenance closures.");
assert.match(performanceIntakeWorkflow, /actions\/runs\/\$\{GITHUB_RUN_ID\}\/approvals/);
assert.match(performanceIntakeWorkflow, /brainpet-active-30m\.json[\s\S]*brainpet-idle-24h\.json[\s\S]*brainpet-performance-intake\.json/);
assert.match(performanceIntakeWorkflow, /brainpet-sigstore-provenance\.mjs/);
assert.match(publicFinalizeWorkflow, /--performance output\/performance\/performance --performance-provenance output\/performance\/provenance/);
assert.match(publicFinalizeWorkflow, /--candidate-receipt output\/candidate\/candidate-receipt\/brainpet-release-receipt\.json/, "Final public aggregation must bind the exact candidate receipt used by performance evidence.");
assert.match(publicFinalizeWorkflow, /download-brainpet-performance-receipts\.mjs[\s\S]*--candidate-package output\/candidate\/packages\/brainpet-public-runtime-current-windows-x64 --candidate-provenance output\/candidate\/provenance/, "Final performance download must bind the same official package and provenance closures as protected intake.");
assert.match(publicFinalizeWorkflow, /BRAINPET_CANDIDATE_RUN_ID: \$\{\{ inputs\.candidate_run_id \}\}/);
assert.match(publicFinalizeWorkflow, /BRAINPET_PHYSICAL_RECEIPT_RUN_ID: \$\{\{ inputs\.physical_receipt_run_id \}\}/);
assert.match(publicFinalizeWorkflow, /BRAINPET_PERFORMANCE_RECEIPT_RUN_ID: \$\{\{ inputs\.performance_receipt_run_id \}\}/);
const packageValidatorSource = readFileSync(join(desktop, "scripts", "validate-brainpet-package.mjs"), "utf8");
assert.match(packageValidatorSource, /assertMacosCodeObjectIsUnsigned/);
assert.match(packageValidatorSource, /--appimage-signature/);
assert.match(packageValidatorSource, /deb unexpectedly contains an embedded signature or non-standard archive member/);
assert.match(packageValidatorSource, /assertBrainPetAsarWorkspaceClosure[\s\S]*non-runtime workspace file/);
assert.match(packageValidatorSource, /appAsarSha256:/, "Package receipts must bind the packaged application bytes.");
assert.match(packageValidatorSource, /const runtimeTree = createBrainPetRuntimeTree\(unpackedRoot\)[\s\S]*runtimeTree,/, "Package receipts must bind the complete unpacked runtime tree.");
assert.match(packageValidatorSource, /brainPetDistributionContract\.identity\.executableName}\.app/, "macOS package receipts must use the exact case-sensitive bundle name emitted from executableName.");
assert.doesNotMatch(packageValidatorSource, /join\(unpackedRoot, "BrainPet\.app"/, "macOS package validation must not rely on the runner filesystem being case-insensitive.");
const performanceReceiptSource = readFileSync(join(desktop, "scripts", "brainpet-performance-receipt.mjs"), "utf8");
assert.match(performanceReceiptSource, /--untracked-files=no/);
assert.match(performanceReceiptSource, /packageReceipt\.source\.treeDirty, false/);
assert.match(performanceReceiptSource, /await link\(temporary, target\)/, "Successful performance receipts must use non-overwriting atomic publication.");
assert.match(performanceReceiptSource, /validateBrainPetRuntimeTree\(runtimeRoot, packageReceipt\.runtimeTree\)/);
assert.match(performanceReceiptSource, /packageReceipt\.releaseMode, "public-release"|packageReceipt\.releaseMode === "public-release"/, "Formal performance receipts must support the public installer candidate.");
assert.match(performanceReceiptSource, /Prepared Windows package receipt differs from the public aggregate receipt/, "Prepared performance candidates must bind the public aggregate receipt.");
assert.match(performanceReceiptSource, /validatePreparedProvenance/, "Prepared performance candidates must bind their Sigstore bundle bytes.");
assert.match(performanceReceiptSource, /verifyBrainPetSigstoreSubject[\s\S]*verification\.verifier\(\{[\s\S]*workflowPath: brainPetPublicReleaseWorkflow\.path[\s\S]*sourceCommit: verification\.sourceCommit/, "Prepared performance candidates must cryptographically verify each Sigstore subject against the public workflow and commit.");
assert.match(performanceReceiptSource, /validateBrainPetFormalGateResult/);
assert.match(performanceReceiptSource, /BrainPetPerformanceReceiptRollbackError[\s\S]*receiptPath = resolve\(receiptPath\)/);
const performanceRunnerSource = readFileSync(join(desktop, "scripts", "brainpet-performance-gate-runner.mjs"), "utf8");
assert.match(performanceRunnerSource, /detached: true/);
assert.match(performanceRunnerSource, /identity\.creationDate === expected\.creationDate/);
assert.match(performanceRunnerSource, /identity\.executablePath/);
assert.match(performanceRunnerSource, /commandNeedles\.every/);
assert.match(performanceRunnerSource, /createCleanPerformanceEnvironment\([\s\S]*BRAINPET_ENFORCE_RESOURCE_BUDGET: "1"/);
assert.match(performanceRunnerSource, /"SystemDrive"[\s\S]*"ProgramData"/, "Formal Windows performance sampling must preserve absolute machine roots required by native components.");
assert.match(performanceRunnerSource, /validateBrainPetPreparedPerformanceCandidate/);
assert.match(performanceRunnerSource, /--candidate <prepared-manifest>/);
assert.doesNotMatch(performanceRunnerSource, /package:brainpet:unpacked/, "Formal performance runs must not rebuild a private package locally.");
assert.doesNotMatch(performanceRunnerSource, /runPnpmDesktopScript/, "Formal performance runs must execute the prepared public runtime directly.");
assert.match(performanceRunnerSource, /status\.state === "interrupted" && status\.receiptPath[\s\S]*rmSyncExact/);
assert.match(performanceRunnerSource, /maximumTotalWorkingSetBytes|validateBrainPetFormalGateResult/);
assert.match(performanceRunnerSource, /brainpet-windows-job-supervisor\.ps1[\s\S]*child-supervisor-ready[\s\S]*brainpet-windows-job-resume-permit[\s\S]*jobQuiescent/);
assert.match(performanceRunnerSource, /supervisorExitCode[\s\S]*validateWindowsJobSupervisorResult[\s\S]*does not match its supervisor exit status/);
assert.match(performanceRunnerSource, /completion publication failed[\s\S]*preserving the recovery lease/);
assert.match(performanceRunnerSource, /caught instanceof BrainPetPerformanceReceiptRollbackError[\s\S]*throw caught/);
assert.match(performanceRunnerSource, /renameReplaceAtomicWithRetry[\s\S]*\["EPERM", "EACCES", "EBUSY"\]/, "Windows performance lease replacement must retry only bounded transient file-lock errors.");
const electronSmokeSource = readFileSync(join(desktop, "scripts", "brainpet-electron-smoke.mjs"), "utf8");
assert.match(electronSmokeSource, /spawnSync\(stagedHelper[\s\S]*cwd: wakeRoot[\s\S]*stdio: \["pipe", "ignore", "ignore"\]/, "Cold-wake timing must wait for the helper process without retaining output pipes in the detached runtime.");
const performanceJobSupervisorSource = readFileSync(join(desktop, "scripts", "brainpet-windows-job-supervisor.ps1"), "utf8");
assert.match(performanceJobSupervisorSource, /CREATE_SUSPENDED[\s\S]*JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE[\s\S]*AssignProcessToJobObject[\s\S]*TerminateProcess[\s\S]*Suspended child termination wait/);
assert.match(performanceJobSupervisorSource, /WaitForPermit\(resumePermitPath[\s\S]*ResumeThread[\s\S]*QueryActiveProcesses[\s\S]*TerminateJobObject/);
assert.match(performanceJobSupervisorSource, /jobQuiescent[\s\S]*remainingProcesses/);
const desktopPackage = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
assert.equal(desktopPackage.scripts["test:brainpet-soak"], "pnpm brainpet:active-gate:start");
assert.equal(desktopPackage.scripts["test:brainpet-idle-soak"], "pnpm brainpet:idle-gate:start");
assert.match(desktopPackage.scripts.test, /prepare-brainpet-public-performance-candidate\.test\.mjs/, "Default desktop tests must cover public performance-candidate preparation.");
const performancePreparationSource = readFileSync(join(root, "scripts", "prepare-brainpet-public-performance-candidate.mjs"), "utf8");
assert.match(performancePreparationSource, /brainpet-public-runtime-current-windows-x64/);
assert.match(performancePreparationSource, /validateBrainPetPackageArtifactClosure/);
assert.match(performancePreparationSource, /tar\.exe[\s\S]*-tf[\s\S]*-xf/, "Public performance preparation must inspect the NSIS archive before extraction.");
assert.match(performancePreparationSource, /createProvenanceRecord\("candidate-receipt"[\s\S]*createProvenanceRecord\("package-receipt"[\s\S]*createProvenanceRecord\("installer"/, "Prepared candidate must bind candidate, package, and installer provenance bundles.");
assert.match(performancePreparationSource, /validateSelectedProvenanceDirectory[\s\S]*closure is incomplete or contains an extra file/, "Prepared candidate must stage an exact selected Sigstore bundle closure.");
const performanceReleaseContractSource = readFileSync(join(root, "scripts", "brainpet-performance-release-contract.mjs"), "utf8");
for (const key of ["packageReceiptSha256", "publicCandidateReceiptSha256", "provenanceBundleSha256"]) assert.match(performanceReleaseContractSource, new RegExp(key), `Final performance validation must bind ${key}.`);
const aggregateReleaseSource = readFileSync(join(root, "scripts", "aggregate-brainpet-release-receipt.mjs"), "utf8");
assert.match(aggregateReleaseSource, /validatePublicCandidatePerformanceBinding[\s\S]*packageReceiptSha256[\s\S]*publicCandidateReceiptSha256[\s\S]*provenanceBundleSha256/, "Final aggregation must derive exact performance bindings from the official public candidate bytes.");
const performanceIntakeSource = readFileSync(join(root, "scripts", "intake-brainpet-performance-receipts.mjs"), "utf8");
assert.match(performanceIntakeSource, /validateBrainPetPackageArtifactClosure[\s\S]*publicCandidateReceiptSha256[\s\S]*packageReceiptSha256[\s\S]*provenanceBundleSha256/, "Protected performance intake must bind every receipt to the official public candidate bytes.");
const performanceDownloadSource = readFileSync(join(root, "scripts", "download-brainpet-performance-receipts.mjs"), "utf8");
assert.match(performanceDownloadSource, /validateBrainPetPackageArtifactClosure[\s\S]*candidateBundlePath[\s\S]*packageReceiptSha256[\s\S]*provenanceBundleSha256/, "Final performance download must reconstruct the exact protected-intake candidate binding.");
for (const scriptName of ["package:brainpet", "package:brainpet:portable", "package:brainpet:unpacked"]) assert.match(desktopPackage.scripts[scriptName], /^node scripts\/brainpet-package\.mjs/, `${scriptName} must use the self-contained fresh package entrypoint.`);
const packageSource = readFileSync(join(desktop, "scripts", "brainpet-package.mjs"), "utf8");
assert.match(packageSource, /workspacePackageNames[\s\S]*"apps\/desktop\/src"[\s\S]*packages\/\$\{name\}\/src[\s\S]*\["dist", "\.test-dist", "\.brainpet-package"\][\s\S]*\["dist", "\.test-dist"\][\s\S]*assertCanonicalPackageInputsTracked\(\)[\s\S]*"pnpm\.cmd"[\s\S]*"@open-pets\/desktop", "build"/);
assert.match(baseConfig, /!node_modules\/@open-pets\/\*\/src[\s\S]*!node_modules\/@open-pets\/\*\/\.test-dist[\s\S]*!node_modules\/@open-pets\/\*\/tests[\s\S]*!node_modules\/@open-pets\/\*\/contracts[\s\S]*!node_modules\/@open-pets\/\*\/codemap/);
assert.match(packageSource, /cargo(?:\.exe)?"[\s\S]*"build", "--locked", "--release"/);
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
