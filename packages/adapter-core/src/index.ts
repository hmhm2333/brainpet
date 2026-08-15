import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { adapterContractVersion, targetProductDefinitions } from "./generated-contract.js";

export { adapterContractVersion, targetProductDefinitions } from "./generated-contract.js";

export const targetProducts = ["brainpet", "openpets"] as const;
export type TargetProduct = typeof targetProducts[number];

export interface TargetProfile {
  readonly product: TargetProduct;
  readonly appId: "dev.brainpet.app" | "dev.openpets.app";
  readonly discoveryPath: string;
  readonly runtimeMarkerPath: string;
  readonly updateChannel: "hmhm2333/brainpet" | "alvinunreal/openpets";
  readonly adapterVersion: typeof adapterContractVersion;
}

export type AdapterCapabilityStatus = "implemented" | "unavailable";
export type AdapterInstallerKind = "codex-plugin" | "claude-hooks" | "opencode-plugin" | "mcp-server";

export interface AdapterDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly supportedProducts: readonly TargetProduct[];
  readonly automaticLifecycle: boolean;
  readonly lifecycleMethod: "agent.activity" | null;
  readonly installerKind: AdapterInstallerKind;
  readonly capabilities: Readonly<{
    lifecycle: AdapterCapabilityStatus;
    taskNavigation: AdapterCapabilityStatus;
    requestActions: AdapterCapabilityStatus;
    message: AdapterCapabilityStatus;
    voice: AdapterCapabilityStatus;
  }>;
}

export type EventMapper<Input, Output> = (input: Input, occurredAt?: number) => Output | null;

export interface InstallerPlan {
  readonly providerId: string;
  readonly installerKind: AdapterInstallerKind;
  readonly target: TargetProfile;
  readonly scope: "global" | "project";
  readonly mode: "install" | "uninstall" | "doctor";
}

export function defineAdapterDescriptor<const Descriptor extends AdapterDescriptor>(descriptor: Descriptor): Descriptor {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(descriptor.id)) throw new TypeError("Adapter id is invalid.");
  if (!descriptor.displayName || descriptor.supportedProducts.length < 1 || descriptor.supportedProducts.some((product) => !targetProducts.includes(product))) throw new TypeError("Adapter descriptor is invalid.");
  if (descriptor.automaticLifecycle !== (descriptor.lifecycleMethod === "agent.activity")) throw new TypeError("Automatic adapters must use agent.activity exactly once.");
  if (descriptor.capabilities.lifecycle !== (descriptor.automaticLifecycle ? "implemented" : "unavailable")) throw new TypeError("Adapter lifecycle capability is inconsistent.");
  return Object.freeze(descriptor);
}

export function createInstallerPlan(input: Omit<InstallerPlan, "target"> & { readonly target: TargetProduct | TargetProfile }): InstallerPlan {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.providerId)) throw new TypeError("Installer provider id is invalid.");
  return Object.freeze({ ...input, target: isTargetProfile(input.target) ? input.target : resolveTargetProfile(input.target) });
}

export function resolveTargetProfile(
  product: TargetProduct,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): TargetProfile {
  if (!targetProducts.includes(product)) throw new TypeError(`Unsupported companion target product: ${String(product)}`);
  const definition = targetProductDefinitions[product];
  const discoveryPath = environment.OPENPETS_DISCOVERY_FILE ?? resolveDiscoveryPath(platform, environment, homeDirectory, definition.productDirectory, definition.runtimeNamespace);
  return {
    product,
    appId: definition.appId,
    discoveryPath,
    runtimeMarkerPath: resolveRuntimeMarkerPath(platform, environment, homeDirectory, definition.productDirectory),
    updateChannel: definition.updateChannel,
    adapterVersion: adapterContractVersion,
  };
}

export function isTargetProfile(value: unknown): value is TargetProfile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TargetProfile>;
  const product = candidate.product;
  if (!targetProducts.includes(product as TargetProduct)) return false;
  const definition = targetProductDefinitions[product as TargetProduct];
  return candidate.appId === definition.appId
    && typeof candidate.discoveryPath === "string" && candidate.discoveryPath.length > 0
    && typeof candidate.runtimeMarkerPath === "string" && candidate.runtimeMarkerPath.length > 0
    && candidate.updateChannel === definition.updateChannel
    && candidate.adapterVersion === adapterContractVersion;
}

function resolveDiscoveryPath(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, homeDirectory: string, productDirectory: string, runtimeNamespace: string): string {
  if (platform === "darwin") return join(homeDirectory, "Library", "Application Support", productDirectory, "runtime", "ipc.json");
  if (platform === "win32") return join(environment.APPDATA ?? join(homeDirectory, "AppData", "Roaming"), productDirectory, "runtime", "ipc.json");
  const xdgRuntime = getSecureXdgRuntimeDir(environment.XDG_RUNTIME_DIR);
  if (xdgRuntime) return join(xdgRuntime, runtimeNamespace, "ipc.json");
  return join(environment.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"), productDirectory, "runtime", "ipc.json");
}

function resolveRuntimeMarkerPath(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, homeDirectory: string, productDirectory: string): string {
  if (platform === "darwin") return join(homeDirectory, "Library", "Application Support", productDirectory, "runtime-install.json");
  if (platform === "win32") return join(environment.LOCALAPPDATA ?? join(homeDirectory, "AppData", "Local"), productDirectory, "runtime-install.json");
  return join(environment.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"), productDirectory, "runtime-install.json");
}

function getSecureXdgRuntimeDir(path: string | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
    if ((stat.mode & 0o777) !== 0o700) return null;
    return path;
  } catch {
    return null;
  }
}
