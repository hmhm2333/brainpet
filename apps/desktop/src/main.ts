import { app } from "electron";
import { basename, join } from "node:path";

import { completeOnboarding, getAppStateSnapshot, initializeAppState, isOnboardingCompleted, releaseStartupInstallLock } from "./app-state.js";
import { createAppIcon } from "./assets.js";
import { setLocaleFromPreference, t } from "./i18n/index.js";
import { applyExternalPetSay, installDefaultPetDisplayHandlers, shouldOpenDefaultPetOnLaunch, showDefaultPet } from "./default-pet-controller.js";
import { installAppLifecycle } from "./lifecycle.js";
import { error as logError, getLogFilePath, info, initializeLogger, warn } from "./logger.js";
import { configureLocalIpcCapabilities, startLocalIpcServer } from "./local-ipc.js";
import { configureAppTray, createAppTray, refreshTrayMenu } from "./tray.js";
import { checkForGitHubReleaseUpdate } from "./update-checker.js";
import { initializeBrainPetHost } from "./brainpet/host.js";
import { initializeAgentLifecycleController } from "./agent-lifecycle-controller.js";
import { isBrainPetFeatureEnabled, resolveDesktopDistributionSettings, shouldUseIsolatedBrainPetUserData } from "./distribution-profile.js";
import { createBrainPetInstallMarker, resolveBrainPetMarkerExecutablePath, writeBrainPetInstallMarker } from "./brainpet-install-marker.js";
import { shouldShowBrainPetFirstRunGuide } from "./brainpet-first-run.js";
import { resolveDesktopComposition } from "./composition/desktop-composition.js";
import { initializeBrainPetInstallationState, recordBrainPetRuntimeReady } from "./brainpet-installation-state.js";
import { configurePetWindowCapabilities } from "./pet-window.js";
import { configureLocalIpcDistributionProfile } from "./local-ipc-paths.js";
import { configureBrainPetSetupGuide } from "./brainpet-setup-guide.js";

const distribution = resolveDesktopDistributionSettings(app.getName(), process.env.OPENPETS_DISTRIBUTION_PROFILE, basename(process.execPath), { packaged: app.isPackaged });
const brainPetFeatureEnabled = isBrainPetFeatureEnabled(distribution, process.env.BRAINPET_ENABLED);
const composition = resolveDesktopComposition(distribution, brainPetFeatureEnabled);
configurePetWindowCapabilities({ brainPetSurface: composition.capabilities.brainPetHost, productName: distribution.displayName });
configureLocalIpcDistributionProfile(distribution.profile);
configureBrainPetSetupGuide({ enabled: composition.capabilities.brainPetHost });
if (shouldUseIsolatedBrainPetUserData(distribution.profile, process.argv)) {
  app.setPath("userData", join(app.getPath("appData"), "BrainPet"));
}

// OpenPets stores plugin secrets via Electron safeStorage, which requires a
// real encryption backend. On Linux use the keyring so safeStorage can
// encrypt; on macOS/Windows keep Chromium from prompting for Keychain during
// startup/profile initialization.
//
// gnome-libsecret is Electron's OSCrypt backend written against real GNOME
// Keyring; on KDE, KWallet's secret-service-compat layer implements the same
// org.freedesktop.secrets D-Bus API (verified directly with secret-tool) but
// doesn't satisfy Electron's stricter gnome-libsecret compatibility check, so
// safeStorage.isEncryptionAvailable() returns false and plugin secret saves
// fail with "Secret storage encryption is unavailable on this system." Use
// the kwallet backend on KDE sessions instead.
app.commandLine.appendSwitch("use-mock-keychain");
if (process.platform === "linux") {
  const isKde = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().includes("kde");
  app.commandLine.appendSwitch("password-store", isKde ? "kwallet6" : "gnome-libsecret");
} else {
  app.commandLine.appendSwitch("password-store", "basic");
}

// Chromium's native window occlusion tracker treats every window on a display
// as occluded while a fullscreen app is active there and stops painting it.
// For transparent always-on-top pet windows that means the pet goes blank
// during any fullscreen video or game even when its z-order is intact.
// Occlusion-based paint throttling saves next to nothing for windows this
// small, so trade it away to keep the pet drawn.
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

// OpenPets requires programmatic window positioning and z-ordering, which
// native Wayland compositors disallow for XDG-shell toplevels. To ensure
// gravity, drag, and always-on-top work correctly on all KDE/GNOME Linux
// desktops, we force the x11/XWayland backend. Users who explicitly need
// native Wayland can set OPENPETS_ALLOW_WAYLAND=1, but gravity, walkabout,
// and manual drag will not function under native Wayland.
const isLinux = process.platform === "linux";
const allowWayland = process.env.OPENPETS_ALLOW_WAYLAND === "1";
const hasExplicitOzonePlatformArg = process.argv.some(
  (arg) => arg === "--ozone-platform" || arg.startsWith("--ozone-platform="),
);
// When OPENPETS_ALLOW_WAYLAND=1 we deliberately do NOT append an ozone-platform
// switch: Electron honours the system default (typically wayland on a Wayland
// session, or any explicit --ozone-platform the user passed) and we warn at
// startup that positioning/gravity/walkabout/drag are unsupported there.
if (isLinux && !allowWayland) {
  // Force x11 even if the user passed --ozone-platform=wayland or auto;
  // we overwrite any pre-existing switch so nothing silently slips through.
  app.commandLine.appendSwitch("ozone-platform", "x11");
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  installAppLifecycle();

  app.whenReady().then(async () => {
    initializeLogger();
    app.setName(distribution.displayName);
    if (process.platform === "win32") {
      app.setAppUserModelId(distribution.appUserModelId);
    }
    info("app", "startup begin", { version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged, pid: process.pid, ozonePlatform: app.commandLine.getSwitchValue("ozone-platform") || null, explicitOzonePlatformArg: hasExplicitOzonePlatformArg });
    if (isLinux && allowWayland) {
      const effectiveOzone = app.commandLine.getSwitchValue("ozone-platform") || "(auto/system)";
      warn("app", "native Wayland mode active — pet positioning, gravity, walkabout, and drag are unsupported under native Wayland; remove OPENPETS_ALLOW_WAYLAND=1 to restore full functionality", { effectiveOzone });
    }

    if (process.platform === "darwin") {
      app.dock?.setIcon(createAppIcon());
      app.dock?.hide();
    }

    initializeAppState();
    if (composition.capabilities.brainPetHost) initializeBrainPetInstallationState(app.getPath("userData"));
    if (composition.capabilities.brainPetInstallMarker && app.isPackaged) {
      const markerPath = writeBrainPetInstallMarker(createBrainPetInstallMarker({ executablePath: resolveBrainPetMarkerExecutablePath(process.execPath), appVersion: app.getVersion(), channel: process.env.BRAINPET_RELEASE_CHANNEL }));
      info("app", "BrainPet install marker refreshed", { markerPath, channel: process.env.BRAINPET_RELEASE_CHANNEL ?? "stable" });
      recordBrainPetRuntimeReady(app.getVersion());
    }
    // Resolve the UI language before any window or the tray is built.
    setLocaleFromPreference(getAppStateSnapshot().preferences.locale);
    const openPetsRuntime = composition.id === "openpets"
      ? (await import("./composition/openpets-runtime.js")).prepareOpenPetsRuntime(distribution)
      : null;
    configureAppTray({ distribution, capabilities: composition.capabilities });
    createAppTray();
    installDefaultPetDisplayHandlers();
    configureLocalIpcCapabilities({ agentLifecycle: composition.capabilities.agentLifecycle });
    if (composition.capabilities.agentLifecycle) initializeAgentLifecycleController();
    if (composition.capabilities.brainPetHost) initializeBrainPetHost();
    await startLocalIpcServer();
    releaseStartupInstallLock();
    const showBrainPetFirstRunGuide = composition.capabilities.brainPetOnboarding
      && shouldShowBrainPetFirstRunGuide({ profile: distribution.profile, packaged: app.isPackaged, featureEnabled: brainPetFeatureEnabled, onboardingCompleted: isOnboardingCompleted() });
    if (shouldOpenDefaultPetOnLaunch() || showBrainPetFirstRunGuide) {
      showDefaultPet();
    }
    if (showBrainPetFirstRunGuide) {
      setTimeout(() => {
        const result = applyExternalPetSay(t("brainpet.firstRun.guide"), "waving");
        if (result.shown) completeOnboarding();
      }, 650);
    }
    await openPetsRuntime?.startAfterLocalIpc();
    refreshTrayMenu();
    void checkForGitHubReleaseUpdate().then(() => refreshTrayMenu());
    info("app", "startup complete", { composition: composition.id, capabilities: composition.capabilities, logFile: getLogFilePath(), openDefaultPetOnLaunch: shouldOpenDefaultPetOnLaunch() });
    console.log(`${distribution.displayName} desktop shell ready.`);
  }).catch((error: unknown) => {
    releaseStartupInstallLock();
    logError("app", "startup failed", error);
    console.error("Failed to start OpenPets desktop shell.", error);
    app.quit();
  });
}
