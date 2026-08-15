import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { shouldShowBrainPetFirstRunGuide } from "../src/brainpet-first-run.js";
import { createBrainPetSetupReceipt } from "../src/brainpet-setup-receipt.js";
import { brainPetBridgeVersion, clearBrainPetBridgeConfirmation, confirmBrainPetBridge, getBrainPetInstallationState, normalizeBrainPetInstallationState, recordBrainPetLifecycleVerified, resetBrainPetInstallationStateForTests } from "../src/brainpet-installation-state.js";

test("first-run guide is limited to a packaged, enabled BrainPet profile", () => {
  assert.equal(shouldShowBrainPetFirstRunGuide({ profile: "brainpet", packaged: true, featureEnabled: true, onboardingCompleted: false }), true);
  assert.equal(shouldShowBrainPetFirstRunGuide({ profile: "openpets", packaged: true, featureEnabled: true, onboardingCompleted: false }), false);
  assert.equal(shouldShowBrainPetFirstRunGuide({ profile: "brainpet", packaged: false, featureEnabled: true, onboardingCompleted: false }), false);
  assert.equal(shouldShowBrainPetFirstRunGuide({ profile: "brainpet", packaged: true, featureEnabled: false, onboardingCompleted: false }), false);
  assert.equal(shouldShowBrainPetFirstRunGuide({ profile: "brainpet", packaged: true, featureEnabled: true, onboardingCompleted: true }), false);
});

test("setup receipts distinguish installed, missing, and development runtimes", () => {
  assert.deepEqual(createBrainPetSetupReceipt({ packaged: true, markerValid: true }), { runtime: "installed", bridge: "needs-codex-confirmation", nextTask: "manual-check" });
  assert.equal(createBrainPetSetupReceipt({ packaged: true, markerValid: false }).runtime, "missing");
  assert.equal(createBrainPetSetupReceipt({ packaged: false, markerValid: false }).runtime, "development");
  const verifiedState = normalizeBrainPetInstallationState({ schemaVersion: 2, runtimeVersion: "3.4.0", runtimeReadyAt: 10, bridgeConfirmedVersion: brainPetBridgeVersion, bridgeConfirmedAt: 20, lifecycleVerifiedAt: 30, lifecycleVerifiedBridgeVersion: brainPetBridgeVersion });
  assert.deepEqual(createBrainPetSetupReceipt({ packaged: true, markerValid: true, state: verifiedState }), { runtime: "installed", bridge: "verified", nextTask: "verified" });
  const staleBridgeState = normalizeBrainPetInstallationState({ ...verifiedState, bridgeConfirmedVersion: "0.1.0" });
  assert.equal(createBrainPetSetupReceipt({ packaged: true, markerValid: true, state: staleBridgeState }).bridge, "reauthorization-required");
  assert.equal(createBrainPetSetupReceipt({ packaged: true, markerValid: true, state: staleBridgeState }).nextTask, "manual-check");
  const migratedV1 = normalizeBrainPetInstallationState({ schemaVersion: 1, runtimeVersion: "3.4.0", runtimeReadyAt: 10, bridgeConfirmedVersion: brainPetBridgeVersion, bridgeConfirmedAt: 20, lifecycleVerifiedAt: 30 });
  assert.equal(createBrainPetSetupReceipt({ packaged: true, markerValid: true, state: migratedV1 }).nextTask, "manual-check");
});

test("bridge upgrades invalidate lifecycle evidence until the new bridge emits an event", () => {
  resetBrainPetInstallationStateForTests();
  confirmBrainPetBridge("0.1.0", 10);
  recordBrainPetLifecycleVerified(20, "0.1.0");
  assert.equal(getBrainPetInstallationState().lifecycleVerifiedBridgeVersion, "0.1.0");
  confirmBrainPetBridge(brainPetBridgeVersion, 30);
  assert.equal(getBrainPetInstallationState().lifecycleVerifiedAt, null);
  recordBrainPetLifecycleVerified(40, brainPetBridgeVersion);
  assert.equal(getBrainPetInstallationState().lifecycleVerifiedBridgeVersion, brainPetBridgeVersion);
  clearBrainPetBridgeConfirmation();
  assert.equal(getBrainPetInstallationState().bridgeConfirmedVersion, null);
  assert.equal(getBrainPetInstallationState().lifecycleVerifiedAt, null);
  resetBrainPetInstallationStateForTests();
});

test("setup and recovery keeps the BrainPet pixel UI contract", () => {
  const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? resolve(process.cwd(), "apps/desktop");
  const html = readFileSync(resolve(desktopRoot, "assets/brainpet-setup.html"), "utf8");
  assert.match(html, /FusionPixel12ProportionalSC\.woff2/);
  assert.match(html, /border:4px solid #17243b/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /卸载 Bridge 不影响离线桌宠与训练/);
  assert.match(html, /brainpetSetup\.getAdapterStatus/);
  assert.match(html, /brainpetSetup\.connectCodex/);
  assert.match(html, /brainpetSetup\.disconnectCodex/);
  assert.match(html, /检测并连接/);
  assert.doesNotMatch(html, /border-radius/);
});
