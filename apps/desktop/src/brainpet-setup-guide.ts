import { app, BrowserWindow, ipcMain, shell } from "electron";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { BrainPetAdapterManager, BrainPetAdapterOperationError, type BrainPetAdapterStatus } from "./brainpet-adapter-manager.js";
import { readValidBrainPetInstallMarker } from "./brainpet-install-marker.js";
import { info } from "./logger.js";
import { createBrainPetSetupReceipt } from "./brainpet-setup-receipt.js";
import { clearBrainPetBridgeConfirmation, confirmBrainPetBridge, getBrainPetInstallationState } from "./brainpet-installation-state.js";

let setupWindow: BrowserWindow | null = null;
let setupHandlersInstalled = false;
let setupEnabled = false;
let adapterManager: BrainPetAdapterManager | null = null;

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
  ipcMain.handle("brainpet:setup-adapter-status", async (event) => {
    assertSetupSender(event.sender);
    return getSetupSnapshot();
  });
  ipcMain.handle("brainpet:setup-connect-codex", async (event) => {
    assertSetupSender(event.sender);
    try {
      const result = await getAdapterManager().connectOrUpgrade();
      confirmBrainPetBridge();
      info("ui", "BrainPet Codex Bridge connected", { operation: result.receipt.operation, operationId: result.receipt.operationId });
      return { setup: getSetupReceipt(), adapter: result.status, action: { ok: true, operation: result.receipt.operation } };
    } catch (error) {
      const errorCode = error instanceof BrainPetAdapterOperationError ? error.code : "operation-failed";
      info("ui", "BrainPet Codex Bridge connection failed", { errorCode });
      return { ...(await getSetupSnapshot()), action: { ok: false, errorCode } };
    }
  });
  ipcMain.handle("brainpet:setup-disconnect-codex", async (event) => {
    assertSetupSender(event.sender);
    try {
      const result = await getAdapterManager().uninstall();
      clearBrainPetBridgeConfirmation();
      info("ui", "BrainPet Codex Bridge removed", { operationId: result.receipt.operationId });
      return { setup: getSetupReceipt(), adapter: result.status, action: { ok: true, operation: "uninstall" } };
    } catch (error) {
      const errorCode = error instanceof BrainPetAdapterOperationError ? error.code : "operation-failed";
      info("ui", "BrainPet Codex Bridge removal failed", { errorCode });
      return { ...(await getSetupSnapshot()), action: { ok: false, errorCode } };
    }
  });
}

function getSetupReceipt() {
  return createBrainPetSetupReceipt({ packaged: app.isPackaged, markerValid: readValidBrainPetInstallMarker() !== null, state: getBrainPetInstallationState() });
}

async function getSetupSnapshot(adapter?: BrainPetAdapterStatus) {
  return { setup: getSetupReceipt(), adapter: adapter ?? await getAdapterManager().getStatus() };
}

function getAdapterManager(): BrainPetAdapterManager {
  if (adapterManager) return adapterManager;
  const configuredCodexHome = process.env.CODEX_HOME;
  const codexHome = configuredCodexHome && isAbsolute(configuredCodexHome) ? configuredCodexHome : join(homedir(), ".codex");
  const marketplaceRoot = app.isPackaged
    ? join(process.resourcesPath, "integrations", "codex", "brainpet-marketplace")
    : resolve(app.getAppPath(), "..", "..", "integrations", "codex");
  adapterManager = new BrainPetAdapterManager({ userDataPath: app.getPath("userData"), marketplaceRoot, codexHome });
  return adapterManager;
}

function assertSetupSender(sender: Electron.WebContents): void {
  if (!setupEnabled || !setupWindow || setupWindow.isDestroyed() || sender !== setupWindow.webContents) throw new Error("BrainPet setup window is unavailable.");
}
