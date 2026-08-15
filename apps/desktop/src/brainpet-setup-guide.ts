import { app, BrowserWindow, ipcMain, shell } from "electron";
import { basename, join } from "node:path";

import { readValidBrainPetInstallMarker } from "./brainpet-install-marker.js";
import { info } from "./logger.js";
import { createBrainPetSetupReceipt } from "./brainpet-setup-receipt.js";
import { confirmBrainPetBridge, getBrainPetInstallationState } from "./brainpet-installation-state.js";

let setupWindow: BrowserWindow | null = null;
let setupHandlersInstalled = false;
let setupEnabled = false;

export function configureBrainPetSetupGuide(options: { readonly enabled: boolean }): void {
  setupEnabled = options.enabled;
  if (!setupEnabled && setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
}

export function openBrainPetSetupGuide(): void {
  if (!setupEnabled) return;
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  installSetupHandlers();
  const receipt = getSetupReceipt();
  setupWindow = new BrowserWindow({
    width: 548,
    height: 486,
    minWidth: 480,
    minHeight: 420,
    show: false,
    title: "BrainPet · Setup & Recovery",
    backgroundColor: "#d9edf0",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(app.getAppPath(), "brainpet-setup-preload.cjs") },
  });
  setupWindow.setMenu(null);
  setupWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/github\.com\/hmhm2333\/brainpet(?:\/|$)/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  setupWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  setupWindow.once("ready-to-show", () => setupWindow?.show());
  setupWindow.once("closed", () => { setupWindow = null; });
  const guidePath = join(app.getAppPath(), "assets", "brainpet-setup.html");
  void setupWindow.loadFile(guidePath, { query: { runtime: receipt.runtime, bridge: receipt.bridge, nextTask: receipt.nextTask } }).catch((error) => {
    info("ui", "BrainPet setup guide failed to load", { guide: basename(guidePath), error: error instanceof Error ? error.message : String(error) });
    setupWindow?.close();
  });
}

function installSetupHandlers(): void {
  if (setupHandlersInstalled) return;
  setupHandlersInstalled = true;
  ipcMain.handle("brainpet:setup-confirm-bridge", (event) => {
    if (!setupEnabled || !setupWindow || setupWindow.isDestroyed() || event.sender !== setupWindow.webContents) throw new Error("BrainPet setup window is unavailable.");
    confirmBrainPetBridge();
    info("ui", "BrainPet Bridge confirmation recorded");
    return getSetupReceipt();
  });
}

function getSetupReceipt() {
  return createBrainPetSetupReceipt({ packaged: app.isPackaged, markerValid: readValidBrainPetInstallMarker() !== null, state: getBrainPetInstallationState() });
}
