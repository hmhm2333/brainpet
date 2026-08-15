export type OptionalControlCenterRoute = "dashboard" | "pets" | "settings" | "plugins" | "integrations";

export interface OptionalUiPort {
  openControlCenter(route?: OptionalControlCenterRoute): void | Promise<void>;
  focusOpenTasks(): void;
}

const disabledPort: OptionalUiPort = {
  openControlCenter: () => undefined,
  focusOpenTasks: () => undefined,
};

let activePort: OptionalUiPort = disabledPort;

export function configureOptionalUiPort(port: OptionalUiPort | null): void {
  activePort = port ?? disabledPort;
}

export function openOptionalControlCenter(route?: OptionalControlCenterRoute): void {
  void Promise.resolve(activePort.openControlCenter(route)).catch((error: unknown) => {
    logError("app", "control center open failed", error);
  });
}

export function focusOptionalTaskWindows(): void {
  activePort.focusOpenTasks();
}
import { error as logError } from "./logger.js";
