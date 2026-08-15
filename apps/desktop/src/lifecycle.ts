import { app } from "electron";

import { info } from "./logger.js";

export interface AppLifecycleDelegate {
  readonly productName: string;
  focusOpenTasks(): void;
  dispose(): void | Promise<void>;
}

let intentionalQuit = false;
let cleanupStarted = false;
let cleanupFinished = false;
let hardExitTimer: NodeJS.Timeout | null = null;

export function installAppLifecycle(delegate: AppLifecycleDelegate): void {
  app.on("second-instance", () => {
    info("app", "second instance requested");
    console.log(`Second ${delegate.productName} launch requested; keeping existing instance.`);
    delegate.focusOpenTasks();
  });

  app.on("window-all-closed", () => {
    if (!intentionalQuit) {
      info("app", "all task windows closed; tray app kept alive");
      console.log(`All ${delegate.productName} task windows closed; keeping tray app running.`);
    }
  });

  app.on("activate", () => {
    info("app", "activate event");
    console.log(`${delegate.productName} activate event received; not opening a dashboard window.`);
  });

  app.on("before-quit", (event) => {
    if (cleanupFinished) return;
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;
    intentionalQuit = true;
    info("app", "before quit cleanup begin");
    scheduleHardExitFallback("before-quit");
    void Promise.resolve(delegate.dispose()).catch(() => undefined).finally(() => {
      cleanupFinished = true;
      app.quit();
    });
  });
}

export function quitOpenPets(): void {
  intentionalQuit = true;
  info("app", "quit requested");
  scheduleHardExitFallback("quit-requested");
  app.quit();
}

function scheduleHardExitFallback(reason: string): void {
  if (hardExitTimer) return;
  hardExitTimer = setTimeout(() => {
    info("app", "hard exit fallback", { reason });
    app.exit(0);
  }, 5_000);
  hardExitTimer.unref?.();
}
