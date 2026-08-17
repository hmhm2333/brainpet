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

// BrainPet renders only bundled local surfaces and keeps renderer sandboxing,
// but Electron's separate GPU process duplicates enough shared Chromium pages
// to miss the frozen 400 MiB total-working-set budget on the Windows reference
// machine. Keep hardware acceleration enabled while hosting Chromium's GPU
// service as a browser-process thread for the BrainPet Windows product only.
if (distribution.profile === "brainpet" && process.platform === "win32") app.commandLine.appendSwitch("in-process-gpu");

const performanceDebugPort = process.env.BRAINPET_PERFORMANCE_REMOTE_DEBUGGING_PORT;
if (process.env.BRAINPET_GATE_RUN_ID && performanceDebugPort) {
  if (!/^(?:active-30m|idle-24h)-[a-f0-9]{40}-\d{13}-[a-f0-9-]{36}$/i.test(process.env.BRAINPET_GATE_RUN_ID) || !/^\d{2,5}$/.test(performanceDebugPort)) throw new Error("Invalid BrainPet performance cold-wake debugging contract.");
  app.commandLine.appendSwitch("remote-debugging-port", performanceDebugPort);
}

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
      gpuProcessMode: app.commandLine.hasSwitch("in-process-gpu") ? "browser-thread" : "isolated-process",
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
