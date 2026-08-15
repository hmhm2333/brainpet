import type { PluginCommandForm } from "./plugin-sdk-bridge.js";

export interface PetPluginCommand {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly commandId: string;
  readonly commandTitle: string;
  readonly form?: PluginCommandForm;
  readonly placement?: "top" | "submenu";
  readonly priority?: number;
  readonly featured?: boolean;
}

export interface PetPluginMenuItem {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly itemId: string;
  readonly title: string;
  readonly enabled?: boolean;
  readonly checked?: boolean;
}

export type PetPluginCommandResult = { readonly ok: boolean; readonly error?: string } | null;

export interface PetPluginPort {
  getCommands(): Promise<readonly PetPluginCommand[]>;
  getMenuItems(): Promise<readonly PetPluginMenuItem[]>;
  executeCommand(pluginId: string, commandId: string, args?: Record<string, unknown>): Promise<PetPluginCommandResult>;
  executeMenuSelect(pluginId: string, itemId: string): Promise<void>;
  publishPetEvent(petId: string, name: string, payload: Record<string, unknown>): void;
  reclampPetWindows(): void;
}

const disabledPort: PetPluginPort = {
  getCommands: async () => [],
  getMenuItems: async () => [],
  executeCommand: async () => null,
  executeMenuSelect: async () => undefined,
  publishPetEvent: () => undefined,
  reclampPetWindows: () => undefined,
};

let activePort: PetPluginPort = disabledPort;

export function configurePetPluginPort(port: PetPluginPort | null): void {
  activePort = port ?? disabledPort;
}

export const getDefaultPetPluginCommands = (): Promise<readonly PetPluginCommand[]> => activePort.getCommands();
export const getDefaultPetPluginMenuItems = (): Promise<readonly PetPluginMenuItem[]> => activePort.getMenuItems();
export const executeDefaultPetPluginCommand = (pluginId: string, commandId: string, args?: Record<string, unknown>): Promise<PetPluginCommandResult> => activePort.executeCommand(pluginId, commandId, args);
export const executeDefaultPetPluginMenuSelect = (pluginId: string, itemId: string): Promise<void> => activePort.executeMenuSelect(pluginId, itemId);
export const publishOptionalPluginPetEvent = (petId: string, name: string, payload: Record<string, unknown>): void => activePort.publishPetEvent(petId, name, payload);
export const reclampOptionalPluginPetWindows = (): void => activePort.reclampPetWindows();
