export type DesktopDistributionProfile = "openpets" | "brainpet";

export interface DesktopDistributionSettings {
  readonly profile: DesktopDistributionProfile;
  readonly displayName: "OpenPets" | "BrainPet";
  readonly appUserModelId: "dev.openpets.app" | "dev.brainpet.app";
  readonly seedBundledPlugins: boolean;
  readonly bundledPluginIds: readonly string[];
  readonly bundledEnabledPluginIds: readonly string[];
  readonly brainPetEnabled: boolean;
}

const openPetsBundledPluginIds = ["openpets.reminders", "openpets.focus-buddy", "openpets.launch-buddy", "openpets.virtual-pet"] as const;
const openPetsBundledEnabledPluginIds = ["openpets.reminders", "openpets.focus-buddy", "openpets.launch-buddy"] as const;
const brainPetBundledPluginIds = ["brainpet.training"] as const;

export function resolveDesktopDistributionSettings(
  appName: string,
  override?: string,
  executableName?: string,
  options: { readonly packaged?: boolean } = {},
): DesktopDistributionSettings {
  const normalizedOverride = options.packaged ? undefined : override?.trim().toLowerCase();
  const hasBrainPetIdentity = [appName, executableName]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.trim().toLowerCase().replace(/\.exe$/, "") === "brainpet");
  const profile: DesktopDistributionProfile = normalizedOverride === "brainpet"
    ? "brainpet"
    : normalizedOverride === "openpets"
      ? "openpets"
      : hasBrainPetIdentity
        ? "brainpet"
        : "openpets";

  return profile === "brainpet"
    ? { profile, displayName: "BrainPet", appUserModelId: targetProductDefinitions.brainpet.appId, seedBundledPlugins: true, bundledPluginIds: brainPetBundledPluginIds, bundledEnabledPluginIds: brainPetBundledPluginIds, brainPetEnabled: true }
    : { profile, displayName: "OpenPets", appUserModelId: targetProductDefinitions.openpets.appId, seedBundledPlugins: true, bundledPluginIds: openPetsBundledPluginIds, bundledEnabledPluginIds: openPetsBundledEnabledPluginIds, brainPetEnabled: false };
}

export function isBrainPetFeatureEnabled(settings: DesktopDistributionSettings, override?: string): boolean {
  if (settings.profile !== "brainpet") return false;
  if (override === "0") return false;
  return settings.brainPetEnabled;
}

export function shouldUseIsolatedBrainPetUserData(profile: DesktopDistributionProfile, argv: readonly string[]): boolean {
  return profile === "brainpet" && !argv.some((argument) => argument === "--user-data-dir" || argument.startsWith("--user-data-dir="));
}

export function resolveDistributionUpdateRepository(
  settings: DesktopDistributionSettings,
  override?: string,
  options: { readonly packaged?: boolean } = {},
): string {
  const developmentOverride = options.packaged ? undefined : override?.trim();
  if (developmentOverride && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(developmentOverride)) return developmentOverride;
  return targetProductDefinitions[settings.profile].updateChannel;
}
import { targetProductDefinitions } from "@open-pets/adapter-core";
