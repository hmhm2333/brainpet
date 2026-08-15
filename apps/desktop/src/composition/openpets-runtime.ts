import { app, powerMonitor } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { getAppStateSnapshot } from "../app-state.js";
import { applyExternalPetReaction, applyExternalPetSay, getDefaultPetPaused, isDefaultPetVisible } from "../default-pet-controller.js";
import type { DesktopDistributionSettings } from "../distribution-profile.js";
import { debug, error as logError, info, warn } from "../logger.js";
import { configureOptionalUiPort, type OptionalControlCenterRoute } from "../optional-ui-port.js";
import { configurePetPluginPort } from "../pet-plugin-port.js";
import type { RemoteStatusSnapshot } from "../remote-control-protocol.js";
import type { DesktopManagedService, DesktopServiceState } from "./managed-service.js";

export function createOptionalOpenPetsServices(distribution: DesktopDistributionSettings): DesktopManagedService {
  let state: DesktopServiceState = "created";
  let controlCenterModule: typeof import("../windows.js") | null = null;
  let lanModule: typeof import("../lan-controller.js") | null = null;
  let remoteModule: typeof import("../remote-control-service.js") | null = null;
  let pluginServiceModule: typeof import("../plugin-service.js") | null = null;
  let pluginEventsModule: typeof import("../plugin-events-source.js") | null = null;
  let pluginCapabilities: import("../plugin-host-capabilities.js").ElectronPluginHostCapabilities | null = null;
  let pluginWatcher: import("../plugin-dev-watcher.js").DevPluginWatcher | null = null;
  let removeTrayVoiceMenu: (() => void) | null = null;
  let removePowerResume: (() => void) | null = null;
  let controlCenterPromise: Promise<void> | null = null;
  let lanPromise: Promise<void> | null = null;
  let remotePromise: Promise<void> | null = null;
  let pluginPromise: Promise<void> | null = null;

  const ensureLan = (): Promise<void> => {
    if (lanPromise) return lanPromise;
    lanPromise = (async () => {
      lanModule = await import("../lan-controller.js");
      lanModule.initializeLanController();
      lanModule.startLanController();
      info("app", "optional service started", { service: "lan" });
    })();
    return lanPromise;
  };

  const ensureRemote = (): Promise<void> => {
    if (remotePromise) return remotePromise;
    remotePromise = (async () => {
      await ensureLan();
      const [{ initializeRemoteControlService }, { openPetsRemoteVersion }] = await Promise.all([
        import("../remote-control-service.js"),
        import("../remote-control-protocol.js"),
      ]);
      remoteModule = await import("../remote-control-service.js");
      const service = initializeRemoteControlService({
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
      info("app", "optional service started", { service: "remoteControl" });
    })();
    return remotePromise;
  };

  const ensurePluginPlatform = (): Promise<void> => {
    if (pluginPromise) return pluginPromise;
    pluginPromise = (async () => {
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
      pluginServiceModule = serviceModule;
      pluginEventsModule = eventsModule;
      const roots = parseDevPluginEnv(process.env.OPENPETS_DEV_PLUGIN_ROOTS);
      const paths = parseDevPluginEnv(process.env.OPENPETS_DEV_PLUGIN_PATHS);
      const devPluginMode = roots.length > 0 || paths.length > 0;
      settingsModule.initializePluginPlatformSettings(app.getPath("userData"));
      pluginCapabilities = capabilitiesModule.createElectronPluginHostCapabilities(app.getPath("userData"));
      const service = serviceModule.initializePluginService(
        app.getPath("userData"),
        petApiModule.defaultPluginPetApi,
        app.getVersion(),
        new hostModule.ElectronPluginJsHost(),
        writePluginRuntimeLog,
        process.env.OPENPETS_DISABLE_PLUGIN_CATALOG === "1" || devPluginMode,
        resolveBundledOfficialPluginRoots(),
        !devPluginMode && distribution.seedBundledPlugins,
        pluginCapabilities,
        undefined,
        (sourcePath) => pluginWatcher?.addPaths([sourcePath]),
        (sourcePath) => pluginWatcher?.removePath(sourcePath),
        distribution.bundledPluginIds,
        distribution.bundledEnabledPluginIds,
      );
      await service.start();
      const persistedPaths = service.getLocalSourcePaths();
      for (const path of paths) {
        const result = await service.loadLocalPath(path, { autoApprove: true });
        if (!result.ok) logError("app", "dev plugin path load failed", new Error(result.error));
      }
      for (const path of persistedPaths.filter((path) => !paths.includes(path))) {
        const result = await service.loadLocalPath(path, { autoApprove: true });
        if (!result.ok) logError("app", "persisted local plugin load failed", new Error(result.error));
      }
      if (roots.length > 0) {
        const results = await service.loadLocalRoots(roots, { autoApprove: true, pruneStale: true });
        for (const result of results) if (!result.ok) logError("app", "dev plugin root load failed", new Error(`${result.path}: ${result.error}`));
      }
      const watchPaths = Array.from(new Set([...paths, ...service.getLocalSourcePaths()]));
      if (devPluginMode || watchPaths.length > 0) pluginWatcher = watcherModule.startDevPluginWatcher(service, roots, watchPaths);
      const handleResume = () => service.runtime.resyncSchedules();
      powerMonitor.on("resume", handleResume);
      removePowerResume = () => powerMonitor.off("resume", handleResume);
      removeTrayVoiceMenu = await trayModule.installTrayVoiceMenu();
      info("app", "optional service started", { service: "pluginPlatform" });
    })().catch((error) => {
      pluginPromise = null;
      throw error;
    });
    return pluginPromise;
  };

  const ensureControlCenter = (route: OptionalControlCenterRoute = "dashboard"): Promise<void> => {
    const open = async () => {
      await ensurePluginPlatform();
      await ensureRemote();
      if (!controlCenterModule) {
        controlCenterModule = await import("../windows.js");
        controlCenterModule.installInternalUiProtocol();
        controlCenterModule.installInternalUiHandlers();
        info("app", "optional service started", { service: "controlCenter" });
      }
      controlCenterModule.openControlCenterWindow(route);
    };
    controlCenterPromise = (controlCenterPromise ?? Promise.resolve()).then(open);
    return controlCenterPromise;
  };

  return {
    id: "optionalOpenPetsServices",
    async start() {
      if (state === "started") return;
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
        reclampPetWindows: () => { void import("../plugin-pet-registry.js").then(({ reclampPluginPetWindows }) => reclampPluginPetWindows()); },
      });
      state = "started";
      if (process.env.OPENPETS_LAN_MODE === "server" || process.env.OPENPETS_LAN_MODE === "client") await ensureLan();
      if (hasPersistedRemoteListener()) await ensureRemote();
      info("app", "OptionalOpenPetsServices ready", { lazy: true });
    },
    async dispose() {
      if (state === "disposed") return;
      configureOptionalUiPort(null);
      configurePetPluginPort(null);
      controlCenterModule?.disposeInternalUi();
      pluginWatcher?.stop();
      pluginWatcher = null;
      removePowerResume?.();
      removePowerResume = null;
      removeTrayVoiceMenu?.();
      removeTrayVoiceMenu = null;
      await pluginServiceModule?.stopPluginService().catch(() => undefined);
      pluginCapabilities?.shutdown();
      pluginCapabilities = null;
      pluginEventsModule?.stopPluginEventSources();
      await remoteModule?.stopRemoteControlService().catch(() => undefined);
      await lanModule?.stopLanController().catch(() => undefined);
      state = "disposed";
      info("app", "OptionalOpenPetsServices disposed");
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
