import assert from "node:assert/strict";
import test from "node:test";

import { isBrainPetFeatureEnabled, resolveDesktopDistributionSettings, shouldUseIsolatedBrainPetUserData } from "../src/distribution-profile.js";

test("BrainPet distribution keeps its identity and starts without bundled plugin hosts", () => {
  assert.deepEqual(resolveDesktopDistributionSettings("BrainPet"), {
    profile: "brainpet",
    displayName: "BrainPet",
    appUserModelId: "dev.brainpet.app",
    seedBundledPlugins: false,
    brainPetEnabled: true,
  });
});

test("OpenPets remains unchanged and explicit test overrides are bounded", () => {
  assert.equal(resolveDesktopDistributionSettings("OpenPets").seedBundledPlugins, true);
  assert.equal(resolveDesktopDistributionSettings("OpenPets").brainPetEnabled, false);
  assert.equal(resolveDesktopDistributionSettings("OpenPets", "brainpet").profile, "brainpet");
  assert.equal(resolveDesktopDistributionSettings("BrainPet", "invalid").profile, "brainpet");
  assert.equal(resolveDesktopDistributionSettings("OpenPets", undefined, "brainpet.exe").profile, "brainpet");
  assert.equal(shouldUseIsolatedBrainPetUserData("brainpet", ["brainpet.exe"]), true);
  assert.equal(shouldUseIsolatedBrainPetUserData("brainpet", ["brainpet.exe", "--user-data-dir=C:\\temp\\probe"]), false);
  assert.equal(shouldUseIsolatedBrainPetUserData("openpets", ["openpets.exe"]), false);
  assert.equal(isBrainPetFeatureEnabled(resolveDesktopDistributionSettings("OpenPets")), false);
  assert.equal(isBrainPetFeatureEnabled(resolveDesktopDistributionSettings("OpenPets"), "1"), true);
  assert.equal(isBrainPetFeatureEnabled(resolveDesktopDistributionSettings("BrainPet"), "0"), false);
});
