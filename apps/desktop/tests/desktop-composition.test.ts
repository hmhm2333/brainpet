import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { resolveDesktopComposition } from "../src/composition/desktop-composition.js";
import { resolveDesktopDistributionSettings } from "../src/distribution-profile.js";

const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? resolve(process.cwd(), "apps/desktop");
const releaseCapabilities = JSON.parse(readFileSync(resolve(desktopRoot, "../../config/brainpet-release-capabilities.json"), "utf8")) as {
  readonly runtimeSnapshots: {
    readonly openpets: Record<string, boolean>;
    readonly brainpetEnabled: Record<string, boolean>;
    readonly brainpetRollback: Record<string, boolean>;
  };
};

test("OpenPets composition preserves the full desktop platform", () => {
  const composition = resolveDesktopComposition(resolveDesktopDistributionSettings("OpenPets"), false);

  assert.equal(composition.id, "openpets");
  assert.deepEqual(composition.capabilities, releaseCapabilities.runtimeSnapshots.openpets);
  assert.equal(composition.capabilities.controlCenter, true);
  assert.equal(composition.capabilities.pluginPlatform, true);
  assert.equal(composition.capabilities.lan, true);
  assert.equal(composition.capabilities.remoteControl, true);
  assert.equal(composition.capabilities.agentLifecycle, true);
  assert.equal(composition.capabilities.brainPetHost, false);
  assert.deepEqual(composition.layers, ["hostCore", "optionalOpenPetsServices"]);
});

test("BrainPet composition injects its feature without optional OpenPets services", () => {
  const composition = resolveDesktopComposition(resolveDesktopDistributionSettings("BrainPet"), true);

  assert.equal(composition.id, "brainpet");
  assert.deepEqual(composition.capabilities, releaseCapabilities.runtimeSnapshots.brainpetEnabled);
  assert.equal(composition.capabilities.localIpc, true);
  assert.equal(composition.capabilities.agentLifecycle, true);
  assert.equal(composition.capabilities.brainPetHost, true);
  assert.equal(composition.capabilities.brainPetInstallMarker, true);
  assert.equal(composition.capabilities.controlCenter, false);
  assert.equal(composition.capabilities.pluginPlatform, false);
  assert.equal(composition.capabilities.lan, false);
  assert.equal(composition.capabilities.remoteControl, false);
  assert.equal(composition.capabilities.voice, false);
  assert.equal(composition.capabilities.openPetsAgentSetup, false);
  assert.deepEqual(composition.layers, ["hostCore", "brainPetFeature"]);
});

test("BrainPet rollback keeps only HostCore and rejects lifecycle ingestion", () => {
  const composition = resolveDesktopComposition(resolveDesktopDistributionSettings("BrainPet"), false);

  assert.equal(composition.id, "brainpet");
  assert.deepEqual(composition.capabilities, releaseCapabilities.runtimeSnapshots.brainpetRollback);
  assert.equal(composition.capabilities.localIpc, true);
  assert.equal(composition.capabilities.agentLifecycle, false);
  assert.equal(composition.capabilities.brainPetHost, false);
  assert.equal(composition.capabilities.brainPetInstallMarker, false);
  assert.equal(composition.capabilities.brainPetOnboarding, false);
  assert.equal(composition.capabilities.openPetsAgentSetup, false);
  assert.equal(composition.capabilities.controlCenter, false);
  assert.equal(composition.capabilities.pluginPlatform, false);
  assert.deepEqual(composition.layers, ["hostCore"]);
});
