import type { DesktopDistributionProfile } from "./distribution-profile.js";

export function shouldShowBrainPetFirstRunGuide(input: {
  readonly profile: DesktopDistributionProfile;
  readonly packaged: boolean;
  readonly featureEnabled: boolean;
  readonly onboardingCompleted: boolean;
}): boolean {
  return input.profile === "brainpet" && input.packaged && input.featureEnabled && !input.onboardingCompleted;
}
