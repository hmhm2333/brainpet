import { app } from "electron";
import { basename, join } from "node:path";

import { resolveDesktopComposition } from "./composition/desktop-composition.js";
import { createDesktopRuntime } from "./composition/desktop-runtime.js";
import type { DesktopServiceLifecycle } from "./composition/managed-service.js";
import { isBrainPetFeatureEnabled, resolveDesktopDistributionSettings, shouldUseIsolatedBrainPetUserData } from "./distribution-profile.js";
import { installAppLifecycle } from "./lifecycle.js";

const distribution = resolveDesktopDistributionSettings(app.getName(), process.env.OPENPETS_DISTRIBUTION_PROFILE, basename(process.execPath), { packaged: app.isPackaged });
const brainPetFeatureEnabled = isBrainPetFeatureEnabled(distribution, process.env.BRAINPET_ENABLED);
const composition = resolveDesktopComposition(distribution, brainPetFeatureEnabled);

// BrainPet renders two small, transparent pixel-art surfaces. Avoid retaining
// a dedicated hardware compositor whose baseline working set is larger than
// the entire decoded scene; software compositing still satisfies the 30/50 fps
// release contract and is exercised by the Electron foundation smoke.
if (distribution.profile === "brainpet") app.disableHardwareAcceleration();

if (shouldUseIsolatedBrainPetUserData(distribution.profile, process.argv)) {
  app.setPath("userData", join(app.getPath("appData"), "BrainPet"));
}

// Keep credential storage non-interactive. Linux still selects the native
// Secret Service backend used by the optional OpenPets plugin platform.
app.commandLine.appendSwitch("use-mock-keychain");
if (process.platform === "linux") {
  const isKde = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().includes("kde");
  app.commandLine.appendSwitch("password-store", isKde ? "kwallet6" : "gnome-libsecret");
} else {
  app.commandLine.appendSwitch("password-store", "basic");
}

// Transparent pet renderers must continue painting above fullscreen windows.
if (process.platform === "win32") app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

// Native Wayland prevents programmatic pet positioning. XWayland remains the
// default; the explicit escape hatch keeps the documented reduced behavior.
const isLinux = process.platform === "linux";
const allowWayland = process.env.OPENPETS_ALLOW_WAYLAND === "1";
const hasExplicitOzonePlatformArg = process.argv.some((arg) => arg === "--ozone-platform" || arg.startsWith("--ozone-platform="));
if (isLinux && !allowWayland) app.commandLine.appendSwitch("ozone-platform", "x11");

let desktopRuntime: DesktopServiceLifecycle | null = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  installAppLifecycle({
    productName: distribution.displayName,
    focusOpenTasks: () => desktopRuntime?.focusOpenTasks(),
    dispose: () => desktopRuntime?.dispose() ?? Promise.resolve(),
  });

  app.whenReady().then(async () => {
    const logger = await import("./logger.js");
    logger.initializeLogger();
    app.setName(distribution.displayName);
    if (process.platform === "win32") app.setAppUserModelId(distribution.appUserModelId);
    logger.info("app", "startup begin", {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      pid: process.pid,
      ozonePlatform: app.commandLine.getSwitchValue("ozone-platform") || null,
      explicitOzonePlatformArg: hasExplicitOzonePlatformArg,
    });
    if (isLinux && allowWayland) {
      const effectiveOzone = app.commandLine.getSwitchValue("ozone-platform") || "(auto/system)";
      logger.warn("app", "native Wayland mode active — pet positioning, gravity, walkabout, and drag are unsupported under native Wayland; remove OPENPETS_ALLOW_WAYLAND=1 to restore full functionality", { effectiveOzone });
    }
    if (process.platform === "darwin") {
      const { createAppIcon } = await import("./assets.js");
      app.dock?.setIcon(createAppIcon());
      app.dock?.hide();
    }

    desktopRuntime = createDesktopRuntime(composition, {
      hostCore: async () => (await import("./composition/host-core.js")).createHostCore(distribution, composition.capabilities),
      optionalOpenPetsServices: async () => (await import("./composition/openpets-runtime.js")).createOptionalOpenPetsServices(distribution),
      brainPetFeature: async () => (await import("./composition/brainpet-feature.js")).createBrainPetFeature(distribution, brainPetFeatureEnabled),
    });
    await desktopRuntime.start();

    const [{ getLogFilePath }, { shouldOpenDefaultPetOnLaunch }] = await Promise.all([
      import("./logger.js"),
      import("./default-pet-controller.js"),
    ]);
    logger.info("app", "startup complete", {
      composition: composition.id,
      capabilities: composition.capabilities,
      services: desktopRuntime.diagnostics(),
      logFile: getLogFilePath(),
      openDefaultPetOnLaunch: shouldOpenDefaultPetOnLaunch(),
    });
    console.log(`${distribution.displayName} desktop shell ready.`);
  }).catch(async (error: unknown) => {
    await import("./app-state.js").then(({ releaseStartupInstallLock }) => releaseStartupInstallLock()).catch(() => undefined);
    const logger = await import("./logger.js");
    logger.error("app", "startup failed", error);
    console.error(`Failed to start ${distribution.displayName} desktop shell.`, error);
    app.quit();
  });
}
