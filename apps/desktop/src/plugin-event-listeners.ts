export type PluginEventListener = (...args: unknown[]) => void;

export interface PluginEventEmitter {
  on(event: string, listener: PluginEventListener): unknown;
  off(event: string, listener: PluginEventListener): unknown;
}

export interface PluginSystemEventHandlers {
  readonly lockScreen: PluginEventListener;
  readonly unlockScreen: PluginEventListener;
  readonly onBattery: PluginEventListener;
  readonly onAc: PluginEventListener;
  readonly suspend: PluginEventListener;
  readonly resume: PluginEventListener;
  readonly displayChanged: PluginEventListener;
}

export function registerPluginSystemEventListeners(
  powerMonitor: PluginEventEmitter,
  screen: PluginEventEmitter,
  handlers: PluginSystemEventHandlers,
): () => void {
  const registrations: Array<readonly [PluginEventEmitter, string, PluginEventListener]> = [];
  let disposed = false;

  const add = (emitter: PluginEventEmitter, event: string, listener: PluginEventListener): void => {
    registrations.push([emitter, event, listener]);
    emitter.on(event, listener);
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    let firstError: unknown;
    for (const [emitter, event, listener] of registrations.reverse()) {
      try { emitter.off(event, listener); }
      catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
  };

  try {
    add(powerMonitor, "lock-screen", handlers.lockScreen);
    add(powerMonitor, "unlock-screen", handlers.unlockScreen);
    add(powerMonitor, "on-battery", handlers.onBattery);
    add(powerMonitor, "on-ac", handlers.onAc);
    add(powerMonitor, "suspend", handlers.suspend);
    add(powerMonitor, "resume", handlers.resume);
    add(screen, "display-added", handlers.displayChanged);
    add(screen, "display-removed", handlers.displayChanged);
    add(screen, "display-metrics-changed", handlers.displayChanged);
    return dispose;
  } catch (error) {
    try { dispose(); } catch { /* preserve the startup error */ }
    throw error;
  }
}
