import type { DesktopDistributionSettings } from "../distribution-profile.js";

export interface DesktopCompositionCapabilities {
  readonly agentLifecycle: boolean;
  readonly brainPetHost: boolean;
  readonly brainPetInstallMarker: boolean;
  readonly brainPetOnboarding: boolean;
  readonly controlCenter: boolean;
  readonly lan: boolean;
  readonly localIpc: boolean;
  readonly openPetsAgentSetup: boolean;
  readonly pluginPlatform: boolean;
  readonly remoteControl: boolean;
  readonly voice: boolean;
}

export interface DesktopComposition {
  readonly id: "openpets" | "brainpet";
  readonly capabilities: DesktopCompositionCapabilities;
  readonly layers: readonly DesktopCompositionLayer[];
}

export type DesktopCompositionLayer = "hostCore" | "optionalOpenPetsServices" | "brainPetFeature";

const openPetsCapabilities: DesktopCompositionCapabilities = Object.freeze({
  agentLifecycle: true,
  brainPetHost: false,
  brainPetInstallMarker: false,
  brainPetOnboarding: false,
  controlCenter: true,
  lan: true,
  localIpc: true,
  openPetsAgentSetup: true,
  pluginPlatform: true,
  remoteControl: true,
  voice: true,
});

const brainPetEnabledCapabilities: DesktopCompositionCapabilities = Object.freeze({
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

const brainPetRollbackCapabilities: DesktopCompositionCapabilities = Object.freeze({
  agentLifecycle: false,
  brainPetHost: false,
  brainPetInstallMarker: false,
  brainPetOnboarding: false,
  controlCenter: false,
  lan: false,
  localIpc: true,
  openPetsAgentSetup: false,
  pluginPlatform: false,
  remoteControl: false,
  voice: false,
});

export function resolveDesktopComposition(
  distribution: DesktopDistributionSettings,
  brainPetFeatureEnabled: boolean,
): DesktopComposition {
  if (distribution.profile === "openpets") {
    return composeOpenPets();
  }
  return composeBrainPet(brainPetFeatureEnabled);
}

export function composeOpenPets(): DesktopComposition {
  return { id: "openpets", capabilities: openPetsCapabilities, layers: ["hostCore", "optionalOpenPetsServices"] };
}

export function composeBrainPet(enabled: boolean): DesktopComposition {
  return {
    id: "brainpet",
    capabilities: enabled ? brainPetEnabledCapabilities : brainPetRollbackCapabilities,
    layers: enabled ? ["hostCore", "brainPetFeature"] : ["hostCore"],
  };
}
