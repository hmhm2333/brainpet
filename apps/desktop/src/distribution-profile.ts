export type DesktopDistributionProfile = "openpets" | "brainpet";

export interface DesktopDistributionSettings {
  readonly profile: DesktopDistributionProfile;
  readonly displayName: "OpenPets" | "BrainPet";
  readonly appUserModelId: "dev.openpets.app" | "dev.brainpet.app";
  readonly seedBundledPlugins: boolean;
}

export function resolveDesktopDistributionSettings(appName: string, override?: string, executableName?: string): DesktopDistributionSettings {
  const normalizedOverride = override?.trim().toLowerCase();
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
    ? { profile, displayName: "BrainPet", appUserModelId: "dev.brainpet.app", seedBundledPlugins: false }
    : { profile, displayName: "OpenPets", appUserModelId: "dev.openpets.app", seedBundledPlugins: true };
}

export function shouldUseIsolatedBrainPetUserData(profile: DesktopDistributionProfile, argv: readonly string[]): boolean {
  return profile === "brainpet" && !argv.some((argument) => argument === "--user-data-dir" || argument.startsWith("--user-data-dir="));
}
