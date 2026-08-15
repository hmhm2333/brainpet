import assert from "node:assert/strict";
import test from "node:test";

import { resolveDesktopComposition } from "../src/composition/desktop-composition.js";
import { resolveDesktopDistributionSettings } from "../src/distribution-profile.js";

test("OpenPets composition preserves the full desktop platform", () => {
  const composition = resolveDesktopComposition(resolveDesktopDistributionSettings("OpenPets"), false);

  assert.equal(composition.id, "openpets");
  assert.equal(composition.capabilities.controlCenter, true);
  assert.equal(composition.capabilities.pluginPlatform, true);
  assert.equal(composition.capabilities.lan, true);
  assert.equal(composition.capabilities.remoteControl, true);
  assert.equal(composition.capabilities.agentLifecycle, true);
  assert.equal(composition.capabilities.brainPetHost, false);
});

test("BrainPet composition starts only the companion runtime surface", () => {
  const composition = resolveDesktopComposition(resolveDesktopDistributionSettings("BrainPet"), true);

  assert.equal(composition.id, "brainpet");
  assert.equal(composition.capabilities.localIpc, true);
  assert.equal(composition.capabilities.agentLifecycle, true);
  assert.equal(composition.capabilities.brainPetHost, true);
  assert.equal(composition.capabilities.brainPetInstallMarker, true);
  assert.equal(composition.capabilities.controlCenter, false);
  assert.equal(composition.capabilities.pluginPlatform, false);
  assert.equal(composition.capabilities.lan, false);
  assert.equal(composition.capabilities.remoteControl, false);
  assert.equal(composition.capabilities.voice, false);
});

test("BrainPet rollback disables every BrainPet-owned integration surface", () => {
  const composition = resolveDesktopComposition(resolveDesktopDistributionSettings("BrainPet"), false);

  assert.equal(composition.id, "brainpet");
  assert.equal(composition.capabilities.localIpc, true);
  assert.equal(composition.capabilities.agentLifecycle, false);
  assert.equal(composition.capabilities.brainPetHost, false);
  assert.equal(composition.capabilities.brainPetInstallMarker, false);
  assert.equal(composition.capabilities.brainPetOnboarding, false);
  assert.equal(composition.capabilities.openPetsAgentSetup, false);
});
