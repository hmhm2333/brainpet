import { closeAllAgentPets } from "../agent-pet-controller.js";
import { initializeAgentLifecycleController, shutdownAgentLifecycleController } from "../agent-lifecycle-controller.js";
import { getAppStateSnapshot, initializeAppState, releaseStartupInstallLock } from "../app-state.js";
import { destroyDefaultPet, getDefaultPetWindowForPlugins, installDefaultPetDisplayHandlers, shouldOpenDefaultPetOnLaunch, showDefaultPet } from "../default-pet-controller.js";
import type { DesktopDistributionSettings } from "../distribution-profile.js";
import { setLocaleFromPreference } from "../i18n/index.js";
import { configureLocalIpcCapabilities, startLocalIpcServer, stopLocalIpcServer } from "../local-ipc.js";
import { configureLocalIpcDistributionProfile } from "../local-ipc-paths.js";
import { info } from "../logger.js";
import { configurePetWindowCapabilities } from "../pet-window.js";
import { configureAppTray, createAppTray, refreshTrayMenu } from "../tray.js";
import type { DesktopCompositionCapabilities } from "./desktop-composition.js";
import type { DesktopManagedService, DesktopServiceState } from "./managed-service.js";

export function createHostCore(
  distribution: DesktopDistributionSettings,
  capabilities: DesktopCompositionCapabilities,
): DesktopManagedService {
  let state: DesktopServiceState = "created";
  let startupUiImmediate: NodeJS.Immediate | null = null;
  let trayFallbackTimer: NodeJS.Timeout | null = null;
  let updateCheckTimer: NodeJS.Timeout | null = null;
  let trayReadyWindow: Electron.BrowserWindow | null = null;
  let trayStarted = false;

  const clearTrayWait = () => {
    if (trayFallbackTimer) clearTimeout(trayFallbackTimer);
    trayFallbackTimer = null;
    trayReadyWindow?.webContents.removeListener("did-finish-load", scheduleTrayAfterPetReady);
    trayReadyWindow = null;
  };

  const startTrayAndUpdate = () => {
    if (trayStarted || state !== "started") return;
    trayStarted = true;
    clearTrayWait();
    createAppTray();
    refreshTrayMenu();
    // Update discovery is not startup-critical and may wake Chromium's network
    // service while the pet is still reaching its cold-idle baseline.
    updateCheckTimer = setTimeout(() => {
      updateCheckTimer = null;
      if (state !== "started") return;
      void import("../update-checker.js")
        .then(({ checkForGitHubReleaseUpdate }) => checkForGitHubReleaseUpdate())
        .then(() => refreshTrayMenu());
    }, 60_000);
    updateCheckTimer.unref?.();
  };

  function scheduleTrayAfterPetReady(): void {
    if (trayStarted || state !== "started") return;
    clearTrayWait();
    // Native Tray construction is synchronous and can contend with the first
    // renderer paint or Agent event. Preserve a short interaction-first window
    // after the pet has loaded, while the outer five-second fallback still
    // guarantees that the tray is eventually created if loading never finishes.
    trayFallbackTimer = setTimeout(startTrayAndUpdate, 2_000);
    trayFallbackTimer.unref?.();
  }

  const startVisibleUi = () => {
    startupUiImmediate = null;
    if (state !== "started") return;
    if (!shouldOpenDefaultPetOnLaunch()) {
      startTrayAndUpdate();
      return;
    }
    showDefaultPet();
    trayReadyWindow = getDefaultPetWindowForPlugins();
    if (!trayReadyWindow || trayReadyWindow.isDestroyed()) {
      startTrayAndUpdate();
      return;
    }
    trayReadyWindow.webContents.once("did-finish-load", scheduleTrayAfterPetReady);
    trayFallbackTimer = setTimeout(startTrayAndUpdate, 5_000);
    trayFallbackTimer.unref?.();
  };

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
      installDefaultPetDisplayHandlers();
      configureLocalIpcCapabilities({ agentLifecycle: capabilities.agentLifecycle });
      if (capabilities.agentLifecycle) initializeAgentLifecycleController();
      await startLocalIpcServer();
      releaseStartupInstallLock();
      state = "started";
      info("app", "HostCore started", { product: distribution.profile, agentLifecycle: capabilities.agentLifecycle });
      // Let the next composition layer (BrainPetFeature) install its training
      // handler before the pet becomes clickable. The native tray can
      // occasionally block the main thread for hundreds of milliseconds, so
      // create it only after the pet renderer is usable; a bounded fallback
      // still guarantees tray availability if the renderer fails to load.
      startupUiImmediate = setImmediate(startVisibleUi);
    },
    dispose() {
      if (state === "disposed") return;
      if (startupUiImmediate) clearImmediate(startupUiImmediate);
      startupUiImmediate = null;
      if (updateCheckTimer) clearTimeout(updateCheckTimer);
      updateCheckTimer = null;
      clearTrayWait();
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
