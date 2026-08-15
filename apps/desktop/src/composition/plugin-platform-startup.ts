import { runResourceTransaction } from "./resource-transaction.js";

export interface PluginPlatformStartupSteps<Service, Capabilities, Watcher> {
  readonly assertActive: () => void;
  readonly createCapabilities: () => Capabilities;
  readonly disposeCapabilities: (capabilities: Capabilities) => void | Promise<void>;
  readonly createService: (capabilities: Capabilities) => Service;
  readonly startService: (service: Service) => Promise<void>;
  readonly stopService: (service: Service) => void | Promise<void>;
  readonly loadSources: (service: Service) => Promise<void>;
  readonly createWatcher: (service: Service) => Watcher | null;
  readonly stopWatcher: (watcher: Watcher) => void | Promise<void>;
  readonly installResumeListener: (service: Service) => () => void;
  readonly installTrayMenu: () => Promise<() => void>;
  readonly beforeCommit?: () => void;
  readonly onCleanupError?: (error: unknown) => void;
}

export interface PluginPlatformStartupResources<Service, Capabilities, Watcher> {
  readonly service: Service;
  readonly capabilities: Capabilities;
  readonly watcher: Watcher | null;
  readonly removeResumeListener: () => void;
  readonly removeTrayMenu: () => void;
}

export function startPluginPlatformTransaction<Service, Capabilities, Watcher>(
  steps: PluginPlatformStartupSteps<Service, Capabilities, Watcher>,
): Promise<PluginPlatformStartupResources<Service, Capabilities, Watcher>> {
  return runResourceTransaction(async (defer) => {
    steps.assertActive();
    const capabilities = steps.createCapabilities();
    defer(() => steps.disposeCapabilities(capabilities));
    const service = steps.createService(capabilities);
    defer(() => steps.stopService(service));
    await steps.startService(service);
    steps.assertActive();
    await steps.loadSources(service);
    steps.assertActive();
    const watcher = steps.createWatcher(service);
    if (watcher) defer(() => steps.stopWatcher(watcher));
    const removeResumeListener = steps.installResumeListener(service);
    defer(removeResumeListener);
    const removeTrayMenu = await steps.installTrayMenu();
    defer(removeTrayMenu);
    steps.assertActive();
    steps.beforeCommit?.();
    return { service, capabilities, watcher, removeResumeListener, removeTrayMenu };
  }, steps.onCleanupError);
}
