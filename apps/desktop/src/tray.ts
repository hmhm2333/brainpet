import { app, Menu, shell, Tray, type MenuItemConstructorOptions } from "electron";
import { basename } from "node:path";

import { getAppStateSnapshot } from "./app-state.js";
import { createTrayIcon } from "./assets.js";
import { getPrimaryCompanionFollowMode, hideDefaultPet, isDefaultPetVisible, setDefaultPetPaused, showDefaultPet, wakePrimaryCompanion } from "./default-pet-controller.js";
import { t } from "./i18n/index.js";
import { quitOpenPets } from "./lifecycle.js";
import { info, openLogsFolder } from "./logger.js";
import { shellState, togglePaused } from "./state.js";
import { getUpdateStatus, openUpdateReleasePage } from "./update-checker.js";
import { resolveDesktopDistributionSettings, type DesktopDistributionSettings } from "./distribution-profile.js";
import type { DesktopCompositionCapabilities } from "./composition/desktop-composition.js";
import { openOptionalControlCenter } from "./optional-ui-port.js";

let distribution = resolveDesktopDistributionSettings(app.getName(), process.env.OPENPETS_DISTRIBUTION_PROFILE, basename(process.execPath), { packaged: app.isPackaged });
let capabilities: DesktopCompositionCapabilities = {
  agentLifecycle: true,
  brainPetHost: false,
  brainPetInstallMarker: false,
  brainPetOnboarding: false,
  controlCenter: true,
  lan: true,
  localIpc: true,
  openPetsAgentSetup: true,
  pluginPlatform: true,
  remoteControl: true,
  voice: true,
};

let tray: Tray | null = null;
let voiceOperationSubscriptionInstalled = false;
let createConfiguredVoiceMenuItems: (() => MenuItemConstructorOptions[]) | null = null;
let disposeVoiceOperationSubscription: (() => void) | null = null;

export function configureAppTray(options: {
  readonly distribution: DesktopDistributionSettings;
  readonly capabilities: DesktopCompositionCapabilities;
}): void {
  distribution = options.distribution;
  capabilities = options.capabilities;
}

export function createAppTray(): Tray {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip(distribution.displayName);
  refreshTrayMenu();
  info("tray", "created");
  console.log(`${distribution.displayName} tray created.`);

  return tray;
}

export function refreshTrayMenu(): void {
  if (!tray) {
    return;
  }

  const state = getAppStateSnapshot();
  const defaultPet = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId && !pet.broken) ?? state.pets.installed[0];
  const defaultPetName = defaultPet?.displayName ?? t("common.builtInPet");

  const menu = Menu.buildFromTemplate([
    {
      label: distribution.displayName,
      enabled: false,
    },
    ...createUpdateMenuItems(),
    { type: "separator" },
    ...(capabilities.voice ? createConfiguredVoiceMenuItems?.() ?? [] : []),
    {
      label: t("tray.defaultPet", { name: defaultPetName }),
      enabled: capabilities.controlCenter,
      click: capabilities.controlCenter ? () => openControlCenter("pets") : undefined,
    },
    {
      label: isDefaultPetVisible() ? t("tray.hideDefaultPet") : getPrimaryCompanionFollowMode() === "paused" ? t("tray.wakeBrainPet") : t("tray.showDefaultPet"),
      click: () => {
        if (isDefaultPetVisible()) {
          hideDefaultPet();
        } else if (getPrimaryCompanionFollowMode() === "paused") {
          wakePrimaryCompanion();
        } else {
          showDefaultPet();
        }

        refreshTrayMenu();
      },
    },
    {
      label: shellState.paused ? t("tray.resumeAllPets") : t("tray.pauseAllPets"),
      click: () => {
        const paused = togglePaused();
        setDefaultPetPaused(paused);
        info("tray", "pause toggled", { paused });
        console.log(paused ? "OpenPets paused." : "OpenPets resumed.");
        refreshTrayMenu();
      },
    },
    { type: "separator" },
    ...(capabilities.controlCenter ? [{
      label: t("tray.managePets"),
      click: () => openControlCenter("pets"),
    }, {
      label: t("tray.controlCenter"),
      click: () => openControlCenter(),
    }, ...(capabilities.openPetsAgentSetup ? [{
      label: t("tray.integrations"),
      click: () => openControlCenter("integrations"),
    }] : [])] : []),
    ...(capabilities.brainPetHost ? [{
      label: t("tray.brainpetSetup"),
      click: () => { void import("./brainpet-setup-guide.js").then(({ openBrainPetSetupGuide }) => openBrainPetSetupGuide()); },
    }] : []),
    ...(capabilities.pluginPlatform ? [{
      label: t("tray.plugins"),
      click: () => openControlCenter("plugins"),
    }] : []),
    ...(capabilities.controlCenter ? [{
      label: t("tray.settings"),
      click: () => openControlCenter("settings"),
    }] : []),
    { type: "separator" },
    {
      label: t("tray.website"),
      click: () => { void shell.openExternal(distribution.profile === "brainpet" ? "https://github.com/hmhm2333/brainpet" : "https://openpets.dev/"); },
    },
    {
      label: t("tray.openLogsFolder"),
      click: () => { void openLogsFolder(); },
    },
    { type: "separator" },
    {
      label: t("tray.quitProduct", { name: distribution.displayName }),
      click: () => quitOpenPets(),
    },
  ]);

  tray.setContextMenu(menu);
}

export async function installTrayVoiceMenu(): Promise<() => void> {
  if (!capabilities.voice || voiceOperationSubscriptionInstalled) return () => undefined;
  const [voice, menu] = await Promise.all([import("./plugin-voice.js"), import("./tray-voice-menu.js")]);
  const createItems = () => menu.createVoiceMenuItems(voice.getPluginVoiceOperation());
  const disposeSubscription = voice.subscribePluginVoiceOperation(() => refreshTrayMenu());
  let installed = false;
  const remove = () => {
    if (!installed) return;
    installed = false;
    disposeVoiceOperationSubscription?.();
    disposeVoiceOperationSubscription = null;
    createConfiguredVoiceMenuItems = null;
    voiceOperationSubscriptionInstalled = false;
    refreshTrayMenu();
  };
  try {
    createConfiguredVoiceMenuItems = createItems;
    disposeVoiceOperationSubscription = disposeSubscription;
    voiceOperationSubscriptionInstalled = true;
    installed = true;
    refreshTrayMenu();
    return remove;
  } catch (error) {
    installed = false;
    try { disposeSubscription(); } catch { /* preserve the startup error */ }
    finally {
      disposeVoiceOperationSubscription = null;
      createConfiguredVoiceMenuItems = null;
      voiceOperationSubscriptionInstalled = false;
    }
    throw error;
  }
}

function openControlCenter(section?: "pets" | "integrations" | "plugins" | "settings"): void {
  openOptionalControlCenter(section);
}

function createUpdateMenuItems(): MenuItemConstructorOptions[] {
  const status = getUpdateStatus();
  if (status.state !== "available") return [];
  return [
    {
      label: t("tray.updateAvailable", { version: status.latestVersion ?? t("common.latest") }),
      click: () => { void openUpdateReleasePage(); },
    },
  ];
}
