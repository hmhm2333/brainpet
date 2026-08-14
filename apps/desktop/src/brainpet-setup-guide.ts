import { app, BrowserWindow, shell } from "electron";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { getBrainPetInstallMarkerPath } from "./brainpet-install-marker.js";
import { info } from "./logger.js";
import { createBrainPetSetupReceipt } from "./brainpet-setup-receipt.js";

let setupWindow: BrowserWindow | null = null;

export function openBrainPetSetupGuide(): void {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  const receipt = createBrainPetSetupReceipt({ packaged: app.isPackaged, markerExists: existsSync(getBrainPetInstallMarkerPath()) });
  setupWindow = new BrowserWindow({
    width: 548,
    height: 486,
    minWidth: 480,
    minHeight: 420,
    show: false,
    title: "BrainPet · Setup & Recovery",
    backgroundColor: "#d9edf0",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
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
