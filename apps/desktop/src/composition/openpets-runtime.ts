import { app, powerMonitor } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { getAppStateSnapshot } from "../app-state.js";
import { applyExternalPetReaction, applyExternalPetSay, getDefaultPetPaused, isDefaultPetVisible } from "../default-pet-controller.js";
import type { DesktopDistributionSettings } from "../distribution-profile.js";
import { debug, error as logError, info, warn } from "../logger.js";
import { configureOptionalLanPetPort } from "../lan-pet-port.js";
import { configureOptionalUiPort, type OptionalControlCenterRoute } from "../optional-ui-port.js";
import { configurePetPluginPort } from "../pet-plugin-port.js";
import type { RemoteStatusSnapshot } from "../remote-control-protocol.js";
import { AsyncOperationDisposedError, AsyncOperationGate } from "./async-operation-gate.js";
import type { DesktopManagedService, DesktopServiceState } from "./managed-service.js";
import { startPluginPlatformTransaction } from "./plugin-platform-startup.js";

export function createOptionalOpenPetsServices(distribution: DesktopDistributionSettings): DesktopManagedService {
  let state: DesktopServiceState = "created";
  let controlCenterModule: typeof import("../windows.js") | null = null;
  let lanModule: typeof import("../lan-controller.js") | null = null;
  let remoteModule: typeof import("../remote-control-service.js") | null = null;
  let pluginServiceModule: typeof import("../plugin-service.js") | null = null;
  let pluginService: import("../plugin-service.js").PluginService | null = null;
  let pluginEventsModule: typeof import("../plugin-events-source.js") | null = null;
  let pluginCapabilities: import("../plugin-host-capabilities.js").ElectronPluginHostCapabilities | null = null;
  let pluginWatcher: import("../plugin-dev-watcher.js").DevPluginWatcher | null = null;
  let removeTrayVoiceMenu: (() => void) | null = null;
  let removePowerResume: (() => void) | null = null;
  let controlCenterPromise: Promise<void> | null = null;
  let lanPromise: Promise<void> | null = null;
  let remotePromise: Promise<void> | null = null;
  let pluginPromise: Promise<void> | null = null;
  let disposePromise: Promise<void> | null = null;
  const operations = new AsyncOperationGate("OptionalOpenPetsServices");

  const disposeAll = async (): Promise<void> => {
    const drained = operations.dispose();
    configureOptionalUiPort(null);
    configurePetPluginPort(null);
    configureOptionalLanPetPort(null);
    await drained;
    try { controlCenterModule?.disposeInternalUi(); } catch (error) { logError("app", "control center cleanup failed", error); }
    controlCenterModule = null;
    try { removeTrayVoiceMenu?.(); } catch (error) { logError("app", "tray voice cleanup failed", error); }
    removeTrayVoiceMenu = null;
    try { removePowerResume?.(); } catch (error) { logError("app", "power resume cleanup failed", error); }
    removePowerResume = null;
    try { pluginWatcher?.stop(); } catch (error) { logError("app", "plugin watcher cleanup failed", error); }
    pluginWatcher = null;
    if (pluginServiceModule && pluginService) await pluginServiceModule.stopPluginService(pluginService).catch((error) => logError("app", "plugin service cleanup failed", error));
    pluginService = null;
    pluginServiceModule = null;
    try { pluginCapabilities?.shutdown(); } catch (error) { logError("app", "plugin capabilities cleanup failed", error); }
    pluginCapabilities = null;
    try { pluginEventsModule?.stopPluginEventSources(); } catch (error) { logError("app", "plugin event source cleanup failed", error); }
    pluginEventsModule = null;
    await remoteModule?.stopRemoteControlService().catch(() => undefined);
    await lanModule?.stopLanController().catch(() => undefined);
    state = "disposed";
    info("app", "OptionalOpenPetsServices disposed");
  };

  const ensureLan = (): Promise<void> => {
    if (lanPromise) return lanPromise;
    lanPromise = operations.run(async (assertActive) => {
      const loaded = await import("../lan-controller.js");
      assertActive();
      lanModule = loaded;
      lanModule.initializeLanController();
      lanModule.startLanController();
      info("app", "optional service started", { service: "lan" });
    });
    return lanPromise;
  };

  const ensureRemote = (): Promise<void> => {
    if (remotePromise) return remotePromise;
    remotePromise = operations.run(async (assertActive) => {
      await ensureLan();
      assertActive();
      const [loadedRemote, { openPetsRemoteVersion }] = await Promise.all([
        import("../remote-control-service.js"),
        import("../remote-control-protocol.js"),
      ]);
      assertActive();
      remoteModule = loadedRemote;
      const service = loadedRemote.initializeRemoteControlService({
        statePath: join(app.getPath("userData"), "openpets-remote-control.json"),
        getStatusSnapshot: () => getRemoteStatusSnapshot(openPetsRemoteVersion),
        isDefaultPetAway: () => lanModule?.isDefaultPetAwayForLan() ?? false,
        applyReaction: (reaction) => ({ shown: applyExternalPetReaction(reaction).shown }),
        applySay: (message, reaction) => ({ shown: applyExternalPetSay(message, reaction).shown }),
        log: (message) => info("remote", message),
      });
      try {
        await service.start();
      } catch {
        warn("remote", "remote control listener unavailable");
      }
      assertActive();
      info("app", "optional service started", { service: "remoteControl" });
    });
    return remotePromise;
  };

  const ensurePluginPlatform = (): Promise<void> => {
    if (pluginPromise) return pluginPromise;
    pluginPromise = operations.run(async (assertActive) => {
      const [serviceModule, watcherModule, capabilitiesModule, hostModule, petApiModule, settingsModule, eventsModule, trayModule] = await Promise.all([
        import("../plugin-service.js"),
        import("../plugin-dev-watcher.js"),
        import("../plugin-host-capabilities.js"),
        import("../plugin-js-host.js"),
        import("../plugin-pet-api.js"),
        import("../plugin-platform-settings.js"),
        import("../plugin-events-source.js"),
        import("../tray.js"),
      ]);
      assertActive();
      const roots = parseDevPluginEnv(process.env.OPENPETS_DEV_PLUGIN_ROOTS);
      const paths = parseDevPluginEnv(process.env.OPENPETS_DEV_PLUGIN_PATHS);
      const devPluginMode = roots.length > 0 || paths.length > 0;
      settingsModule.initializePluginPlatformSettings(app.getPath("userData"));
      const resources = await startPluginPlatformTransaction({
        assertActive,
        createCapabilities: () => capabilitiesModule.createElectronPluginHostCapabilities(app.getPath("userData")),
        disposeCapabilities: (capabilities) => {
          try { capabilities.shutdown(); }
          finally { eventsModule.stopPluginEventSources(); }
        },
        createService: (capabilities) => serviceModule.initializePluginService(
          app.getPath("userData"),
          petApiModule.defaultPluginPetApi,
          app.getVersion(),
          new hostModule.ElectronPluginJsHost(),
          writePluginRuntimeLog,
          process.env.OPENPETS_DISABLE_PLUGIN_CATALOG === "1" || devPluginMode,
          resolveBundledOfficialPluginRoots(),
          !devPluginMode && distribution.seedBundledPlugins,
          capabilities,
          undefined,
          (sourcePath) => pluginWatcher?.addPaths([sourcePath]),
          (sourcePath) => pluginWatcher?.removePath(sourcePath),
          distribution.bundledPluginIds,
          distribution.bundledEnabledPluginIds,
        ),
        startService: (service) => service.start(),
        stopService: (service) => serviceModule.stopPluginService(service),
        loadSources: async (service) => {
          const persistedPaths = service.getLocalSourcePaths();
          for (const path of paths) {
            const result = await service.loadLocalPath(path, { autoApprove: true });
            assertActive();
            if (!result.ok) logError("app", "dev plugin path load failed", new Error(result.error));
          }
          for (const path of persistedPaths.filter((path) => !paths.includes(path))) {
            const result = await service.loadLocalPath(path, { autoApprove: true });
            assertActive();
            if (!result.ok) logError("app", "persisted local plugin load failed", new Error(result.error));
          }
          if (roots.length > 0) {
            const results = await service.loadLocalRoots(roots, { autoApprove: true, pruneStale: true });
            assertActive();
            for (const result of results) if (!result.ok) logError("app", "dev plugin root load failed", new Error(`${result.path}: ${result.error}`));
          }
        },
        createWatcher: (service) => {
          const watchPaths = Array.from(new Set([...paths, ...service.getLocalSourcePaths()]));
          return devPluginMode || watchPaths.length > 0 ? watcherModule.startDevPluginWatcher(service, roots, watchPaths) : null;
        },
        stopWatcher: (watcher) => watcher.stop(),
        installResumeListener: (service) => {
          const handleResume = () => service.runtime.resyncSchedules();
          powerMonitor.on("resume", handleResume);
          return () => { powerMonitor.off("resume", handleResume); };
        },
        installTrayMenu: () => trayModule.installTrayVoiceMenu(),
        beforeCommit: () => info("app", "optional service started", { service: "pluginPlatform" }),
        onCleanupError: (cleanupError) => logError("app", "optional plugin startup rollback cleanup failed", cleanupError),
      });
      pluginServiceModule = serviceModule;
      pluginService = resources.service;
      pluginEventsModule = eventsModule;
      pluginCapabilities = resources.capabilities;
      pluginWatcher = resources.watcher;
      removePowerResume = resources.removeResumeListener;
      removeTrayVoiceMenu = resources.removeTrayMenu;
    }).catch((error) => {
      pluginPromise = null;
      throw error;
    });
    return pluginPromise;
  };

  const ensureControlCenter = (route: OptionalControlCenterRoute = "dashboard"): Promise<void> => {
    const open = async () => {
      operations.assertActive();
      await ensurePluginPlatform();
      operations.assertActive();
      await ensureRemote();
      operations.assertActive();
      if (!controlCenterModule) {
        const loaded = await import("../windows.js");
        operations.assertActive();
        controlCenterModule = loaded;
        controlCenterModule.installInternalUiProtocol();
        controlCenterModule.installInternalUiHandlers();
        info("app", "optional service started", { service: "controlCenter" });
      }
      operations.assertActive();
      controlCenterModule.openControlCenterWindow(route);
    };
    controlCenterPromise = (controlCenterPromise ?? Promise.resolve()).then(() => operations.run(async () => open()));
    return controlCenterPromise;
  };

  return {
    id: "optionalOpenPetsServices",
    async start() {
      if (state === "started") return;
      operations.assertActive();
      configureOptionalUiPort({
        openControlCenter: (route) => ensureControlCenter(route),
        focusOpenTasks: () => controlCenterModule?.focusOpenTaskWindows(),
      });
      configurePetPluginPort({
        getCommands: async () => { await ensurePluginPlatform(); return pluginServiceModule!.getDefaultPetPluginCommands(); },
        getMenuItems: async () => { await ensurePluginPlatform(); return pluginServiceModule!.getDefaultPetPluginMenuItems(); },
        executeCommand: async (pluginId, commandId, args) => { await ensurePluginPlatform(); return pluginServiceModule!.executeDefaultPetPluginCommand(pluginId, commandId, args); },
        executeMenuSelect: async (pluginId, itemId) => { await ensurePluginPlatform(); await pluginServiceModule!.executeDefaultPetPluginMenuSelect(pluginId, itemId); },
        publishPetEvent: (petId, name, payload) => pluginEventsModule?.publishPluginPetEvent(petId, name, payload),
        reclampPetWindows: () => {
          void operations.run(async (assertActive) => {
            const { reclampPluginPetWindows } = await import("../plugin-pet-registry.js");
            assertActive();
            reclampPluginPetWindows();
          }).catch((error: unknown) => {
            if (!(error instanceof AsyncOperationDisposedError)) logError("app", "plugin pet reclamp failed", error);
          });
        },
      });
      configureOptionalLanPetPort({
        reclampPetWindows: () => lanModule?.reclampLanVisitingPetWindows(),
      });
      state = "started";
      if (process.env.OPENPETS_LAN_MODE === "server" || process.env.OPENPETS_LAN_MODE === "client") await ensureLan();
      if (hasPersistedRemoteListener()) await ensureRemote();
      operations.assertActive();
      info("app", "OptionalOpenPetsServices ready", { lazy: true });
    },
    dispose() {
      disposePromise ??= disposeAll();
      return disposePromise;
    },
    diagnostics: () => ({
      id: "optionalOpenPetsServices",
      state,
      details: {
        controlCenter: controlCenterModule !== null,
        pluginPlatform: pluginServiceModule !== null,
        lan: lanModule !== null,
        remoteControl: remoteModule !== null,
        voice: removeTrayVoiceMenu !== null,
      },
    }),
    focusOpenTasks: () => controlCenterModule?.focusOpenTaskWindows(),
  };
}

function parseDevPluginEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(delimiter).map((item) => item.trim()).filter(Boolean).map((item) => resolve(item));
}

function resolveBundledOfficialPluginRoots(): string[] {
  const candidates = [join(process.resourcesPath, "plugins", "official"), resolve(process.cwd(), "plugins", "official"), resolve(app.getAppPath(), "..", "..", "plugins", "official")];
  return Array.from(new Set(candidates.filter((candidate) => existsSync(candidate))));
}

function writePluginRuntimeLog(level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void {
  if (level === "error") logError("plugin", message, fields);
  else if (level === "info") info("plugin", message, fields);
  else if (level === "warn") warn("plugin", message, fields);
  else debug("plugin", message, fields);
}

function getRemoteStatusSnapshot(protocolVersion: 1): RemoteStatusSnapshot {
  const current = getAppStateSnapshot();
  const configuredDefault = current.pets.installed.find((pet) => pet.id === current.preferences.defaultPetId);
  const defaultPet = configuredDefault && !configuredDefault.broken ? configuredDefault : current.pets.installed.find((pet) => pet.builtIn) ?? current.pets.installed[0];
  return {
    ok: true,
    appRunning: true,
    protocolVersion,
    defaultPet: { id: defaultPet?.id ?? "builtin", builtIn: defaultPet?.builtIn === true, broken: defaultPet?.broken === true },
    paused: getDefaultPetPaused(),
    defaultPetVisible: isDefaultPetVisible(),
    openDefaultPetOnLaunch: current.preferences.openDefaultPetOnLaunch,
    speechBubblesEnabled: current.preferences.speechBubblesEnabled,
  };
}

function hasPersistedRemoteListener(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(app.getPath("userData"), "openpets-remote-control.json"), "utf8")) as { readonly config?: { readonly enabled?: unknown } };
    return parsed.config?.enabled === true;
  } catch {
    return false;
  }
}
