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

test("BrainPet composition preserves the OpenPets host and adds the training surface", () => {
  const composition = resolveDesktopComposition(resolveDesktopDistributionSettings("BrainPet"), true);

  assert.equal(composition.id, "brainpet");
  assert.equal(composition.capabilities.localIpc, true);
  assert.equal(composition.capabilities.agentLifecycle, true);
  assert.equal(composition.capabilities.brainPetHost, true);
  assert.equal(composition.capabilities.brainPetInstallMarker, true);
  assert.equal(composition.capabilities.controlCenter, true);
  assert.equal(composition.capabilities.pluginPlatform, true);
  assert.equal(composition.capabilities.lan, true);
  assert.equal(composition.capabilities.remoteControl, true);
  assert.equal(composition.capabilities.voice, true);
  assert.equal(composition.capabilities.openPetsAgentSetup, true);
});

test("BrainPet rollback removes BrainPet features without disabling the OpenPets host", () => {
  const composition = resolveDesktopComposition(resolveDesktopDistributionSettings("BrainPet"), false);

  assert.equal(composition.id, "brainpet");
  assert.equal(composition.capabilities.localIpc, true);
  assert.equal(composition.capabilities.agentLifecycle, true);
  assert.equal(composition.capabilities.brainPetHost, false);
  assert.equal(composition.capabilities.brainPetInstallMarker, false);
  assert.equal(composition.capabilities.brainPetOnboarding, false);
  assert.equal(composition.capabilities.openPetsAgentSetup, true);
  assert.equal(composition.capabilities.controlCenter, true);
  assert.equal(composition.capabilities.pluginPlatform, true);
});
