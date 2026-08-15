import { closeAllAgentPets } from "../agent-pet-controller.js";
import { initializeAgentLifecycleController, shutdownAgentLifecycleController } from "../agent-lifecycle-controller.js";
import { getAppStateSnapshot, initializeAppState, releaseStartupInstallLock } from "../app-state.js";
import { destroyDefaultPet, installDefaultPetDisplayHandlers, shouldOpenDefaultPetOnLaunch, showDefaultPet } from "../default-pet-controller.js";
import type { DesktopDistributionSettings } from "../distribution-profile.js";
import { setLocaleFromPreference } from "../i18n/index.js";
import { configureLocalIpcCapabilities, startLocalIpcServer, stopLocalIpcServer } from "../local-ipc.js";
import { configureLocalIpcDistributionProfile } from "../local-ipc-paths.js";
import { info } from "../logger.js";
import { configurePetWindowCapabilities } from "../pet-window.js";
import { configureAppTray, createAppTray, refreshTrayMenu } from "../tray.js";
import { checkForGitHubReleaseUpdate } from "../update-checker.js";
import type { DesktopCompositionCapabilities } from "./desktop-composition.js";
import type { DesktopManagedService, DesktopServiceState } from "./managed-service.js";

export function createHostCore(
  distribution: DesktopDistributionSettings,
  capabilities: DesktopCompositionCapabilities,
): DesktopManagedService {
  let state: DesktopServiceState = "created";

  return {
    id: "hostCore",
    async start() {
      if (state === "started") return;
      configurePetWindowCapabilities({
        brainPetSurface: capabilities.brainPetHost,
        productName: distribution.displayName,
        controlCenter: capabilities.controlCenter,
        pluginPlatform: capabilities.pluginPlatform,
      });
      configureLocalIpcDistributionProfile(distribution.profile);
      initializeAppState();
      setLocaleFromPreference(getAppStateSnapshot().preferences.locale);
      configureAppTray({ distribution, capabilities });
      createAppTray();
      installDefaultPetDisplayHandlers();
      configureLocalIpcCapabilities({ agentLifecycle: capabilities.agentLifecycle });
      if (capabilities.agentLifecycle) initializeAgentLifecycleController();
      await startLocalIpcServer();
      releaseStartupInstallLock();
      if (shouldOpenDefaultPetOnLaunch()) showDefaultPet();
      refreshTrayMenu();
      void checkForGitHubReleaseUpdate().then(() => refreshTrayMenu());
      state = "started";
      info("app", "HostCore started", { product: distribution.profile, agentLifecycle: capabilities.agentLifecycle });
    },
    dispose() {
      if (state === "disposed") return;
      stopLocalIpcServer();
      shutdownAgentLifecycleController();
      closeAllAgentPets();
      destroyDefaultPet();
      state = "disposed";
      info("app", "HostCore disposed", { product: distribution.profile });
    },
    diagnostics: () => ({ id: "hostCore", state, details: { product: distribution.profile, localIpc: capabilities.localIpc, agentLifecycle: capabilities.agentLifecycle } }),
  };
}
