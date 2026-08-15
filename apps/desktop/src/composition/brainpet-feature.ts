import { app } from "electron";

import { configureAgentLifecycleAcceptedHandler } from "../agent-lifecycle-controller.js";
import { completeOnboarding, isOnboardingCompleted } from "../app-state.js";
import { createBrainPetInstallMarker, resolveBrainPetMarkerExecutablePath, writeBrainPetInstallMarker } from "../brainpet-install-marker.js";
import { shouldShowBrainPetFirstRunGuide } from "../brainpet-first-run.js";
import { configureBrainPetSetupGuide, openBrainPetSetupGuide } from "../brainpet-setup-guide.js";
import { initializeBrainPetInstallationState, recordBrainPetLifecycleVerified, recordBrainPetRuntimeReady } from "../brainpet-installation-state.js";
import { applyExternalPetSay, showDefaultPet } from "../default-pet-controller.js";
import type { DesktopDistributionSettings } from "../distribution-profile.js";
import { t } from "../i18n/index.js";
import { info } from "../logger.js";
import { initializeBrainPetHost, shutdownBrainPetHost } from "../brainpet/host.js";
import type { DesktopManagedService, DesktopServiceState } from "./managed-service.js";

export function createBrainPetFeature(
  distribution: DesktopDistributionSettings,
  brainPetFeatureEnabled: boolean,
): DesktopManagedService {
  let state: DesktopServiceState = "created";
  let guideTimer: NodeJS.Timeout | null = null;
  let setupGuideTimer: NodeJS.Timeout | null = null;

  return {
    id: "brainPetFeature",
    start() {
      if (state === "started") return;
      configureBrainPetSetupGuide({ enabled: true });
      initializeBrainPetInstallationState(app.getPath("userData"));
      if (app.isPackaged) {
        const markerPath = writeBrainPetInstallMarker(createBrainPetInstallMarker({ executablePath: resolveBrainPetMarkerExecutablePath(process.execPath), appVersion: app.getVersion(), channel: process.env.BRAINPET_RELEASE_CHANNEL }));
        info("app", "BrainPet install marker refreshed", { markerPath, channel: process.env.BRAINPET_RELEASE_CHANNEL ?? "stable" });
        recordBrainPetRuntimeReady(app.getVersion());
      }
      configureAgentLifecycleAcceptedHandler(() => recordBrainPetLifecycleVerified());
      initializeBrainPetHost();
      if (process.argv.includes("--brainpet-open-setup-guide") || app.commandLine.hasSwitch("brainpet-open-setup-guide")) {
        setupGuideTimer = setTimeout(() => {
          setupGuideTimer = null;
          openBrainPetSetupGuide();
        }, 250);
        setupGuideTimer.unref?.();
      }
      const showFirstRunGuide = shouldShowBrainPetFirstRunGuide({
        profile: distribution.profile,
        packaged: app.isPackaged,
        featureEnabled: brainPetFeatureEnabled,
        onboardingCompleted: isOnboardingCompleted(),
      });
      if (showFirstRunGuide) {
        showDefaultPet();
        guideTimer = setTimeout(() => {
          guideTimer = null;
          const result = applyExternalPetSay(t("brainpet.firstRun.guide"), "waving");
          if (result.shown) completeOnboarding();
        }, 650);
        guideTimer.unref?.();
      }
      state = "started";
      info("app", "BrainPetFeature started");
    },
    async dispose() {
      if (state === "disposed") return;
      if (guideTimer) clearTimeout(guideTimer);
      guideTimer = null;
      if (setupGuideTimer) clearTimeout(setupGuideTimer);
      setupGuideTimer = null;
      configureAgentLifecycleAcceptedHandler(null);
      configureBrainPetSetupGuide({ enabled: false });
      await shutdownBrainPetHost();
      state = "disposed";
      info("app", "BrainPetFeature disposed");
    },
    diagnostics: () => ({ id: "brainPetFeature", state, details: { trainingEntry: "built-in", pluginRenderer: false } }),
  };
}
