import { app, powerMonitor } from "electron";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { getAppStateSnapshot } from "../app-state.js";
import { applyExternalPetReaction, applyExternalPetSay, getDefaultPetPaused, isDefaultPetVisible } from "../default-pet-controller.js";
import type { DesktopDistributionSettings } from "../distribution-profile.js";
import { initializeLanController, isDefaultPetAwayForLan, startLanController } from "../lan-controller.js";
import { debug, error as logError, info, warn } from "../logger.js";
import { startDevPluginWatcher } from "../plugin-dev-watcher.js";
import { createElectronPluginHostCapabilities } from "../plugin-host-capabilities.js";
import { ElectronPluginJsHost } from "../plugin-js-host.js";
import { defaultPluginPetApi } from "../plugin-pet-api.js";
import { initializePluginPlatformSettings } from "../plugin-platform-settings.js";
import { initializePluginService } from "../plugin-service.js";
import { initializeRemoteControlService } from "../remote-control-service.js";
import { openPetsRemoteVersion, type RemoteStatusSnapshot } from "../remote-control-protocol.js";
import { installInternalUiHandlers, installInternalUiProtocol } from "../windows.js";

export interface PreparedOpenPetsRuntime {
  startAfterLocalIpc(): Promise<void>;
}

export function prepareOpenPetsRuntime(distribution: DesktopDistributionSettings): PreparedOpenPetsRuntime {
  initializeLanController();
  installInternalUiProtocol();
  installInternalUiHandlers();
  const remoteControlService = initializeRemoteControlService({
    statePath: join(app.getPath("userData"), "openpets-remote-control.json"),
    getStatusSnapshot: getRemoteStatusSnapshot,
    isDefaultPetAway: isDefaultPetAwayForLan,
    applyReaction: (reaction) => ({ shown: applyExternalPetReaction(reaction).shown }),
    applySay: (message, reaction) => ({ shown: applyExternalPetSay(message, reaction).shown }),
    log: (message) => info("remote", message),
  });
  return {
    async startAfterLocalIpc() {
      startLanController();
      try {
        await remoteControlService.start();
      } catch {
        warn("remote", "remote control listener unavailable");
      }
      startPluginPlatform(distribution);
    },
  };
}

function startPluginPlatform(distribution: DesktopDistributionSettings): void {
  const roots = parseDevPluginEnv(process.env.OPENPETS_DEV_PLUGIN_ROOTS);
  const paths = parseDevPluginEnv(process.env.OPENPETS_DEV_PLUGIN_PATHS);
  const devPluginMode = roots.length > 0 || paths.length > 0;
  initializePluginPlatformSettings(app.getPath("userData"));
  const pluginCapabilities = createElectronPluginHostCapabilities(app.getPath("userData"));
  let devPluginWatcher: ReturnType<typeof startDevPluginWatcher> | undefined;
  const pluginService = initializePluginService(app.getPath("userData"), defaultPluginPetApi, app.getVersion(), new ElectronPluginJsHost(), writePluginRuntimeLog, process.env.OPENPETS_DISABLE_PLUGIN_CATALOG === "1" || devPluginMode, resolveBundledOfficialPluginRoots(), !devPluginMode && distribution.seedBundledPlugins, pluginCapabilities, undefined, (sourcePath) => devPluginWatcher?.addPaths([sourcePath]), (sourcePath) => devPluginWatcher?.removePath(sourcePath));
  powerMonitor.on("resume", () => pluginService.runtime.resyncSchedules());
  void (async () => {
    await pluginService.start();
    const persistedPaths = pluginService.getLocalSourcePaths();
    for (const path of paths) {
      const result = await pluginService.loadLocalPath(path, { autoApprove: true });
      if (!result.ok) logError("app", "dev plugin path load failed", new Error(result.error));
    }
    for (const path of persistedPaths.filter((path) => !paths.includes(path))) {
      const result = await pluginService.loadLocalPath(path, { autoApprove: true });
      if (!result.ok) logError("app", "persisted local plugin load failed", new Error(result.error));
    }
    if (roots.length > 0) {
      const results = await pluginService.loadLocalRoots(roots, { autoApprove: true, pruneStale: true });
      for (const result of results) if (!result.ok) logError("app", "dev plugin root load failed", new Error(`${result.path}: ${result.error}`));
    }
    const watchPaths = Array.from(new Set([...paths, ...pluginService.getLocalSourcePaths()]));
    if (devPluginMode || watchPaths.length > 0) devPluginWatcher = startDevPluginWatcher(pluginService, roots, watchPaths);
  })().catch((error) => logError("app", "plugin service startup failed", error));
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

function getRemoteStatusSnapshot(): RemoteStatusSnapshot {
  const state = getAppStateSnapshot();
  const configuredDefault = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId);
  const defaultPet = configuredDefault && !configuredDefault.broken ? configuredDefault : state.pets.installed.find((pet) => pet.builtIn) ?? state.pets.installed[0];
  return {
    ok: true,
    appRunning: true,
    protocolVersion: openPetsRemoteVersion,
    defaultPet: { id: defaultPet?.id ?? "builtin", builtIn: defaultPet?.builtIn === true, broken: defaultPet?.broken === true },
    paused: getDefaultPetPaused(),
    defaultPetVisible: isDefaultPetVisible(),
    openDefaultPetOnLaunch: state.preferences.openDefaultPetOnLaunch,
    speechBubblesEnabled: state.preferences.speechBubblesEnabled,
  };
}
