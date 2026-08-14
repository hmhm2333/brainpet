import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { shouldShowBrainPetFirstRunGuide } from "../src/brainpet-first-run.js";
import { createBrainPetSetupReceipt } from "../src/brainpet-setup-receipt.js";

test("first-run guide is limited to a packaged, enabled BrainPet profile", () => {
  assert.equal(shouldShowBrainPetFirstRunGuide({ profile: "brainpet", packaged: true, featureEnabled: true, onboardingCompleted: false }), true);
  assert.equal(shouldShowBrainPetFirstRunGuide({ profile: "openpets", packaged: true, featureEnabled: true, onboardingCompleted: false }), false);
  assert.equal(shouldShowBrainPetFirstRunGuide({ profile: "brainpet", packaged: false, featureEnabled: true, onboardingCompleted: false }), false);
  assert.equal(shouldShowBrainPetFirstRunGuide({ profile: "brainpet", packaged: true, featureEnabled: false, onboardingCompleted: false }), false);
  assert.equal(shouldShowBrainPetFirstRunGuide({ profile: "brainpet", packaged: true, featureEnabled: true, onboardingCompleted: true }), false);
});

test("setup receipts distinguish installed, missing, and development runtimes", () => {
  assert.deepEqual(createBrainPetSetupReceipt({ packaged: true, markerExists: true }), { runtime: "installed", bridge: "needs-codex-confirmation", nextTask: "manual-check" });
  assert.equal(createBrainPetSetupReceipt({ packaged: true, markerExists: false }).runtime, "missing");
  assert.equal(createBrainPetSetupReceipt({ packaged: false, markerExists: false }).runtime, "development");
});

test("setup and recovery keeps the BrainPet pixel UI contract", () => {
  const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? resolve(process.cwd(), "apps/desktop");
  const html = readFileSync(resolve(desktopRoot, "assets/brainpet-setup.html"), "utf8");
  assert.match(html, /FusionPixel12ProportionalSC\.woff2/);
  assert.match(html, /border:4px solid #17243b/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /卸载 Bridge 不影响离线桌宠与训练/);
  assert.doesNotMatch(html, /border-radius/);
});
