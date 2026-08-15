import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const targetProducts = ["brainpet", "openpets"] as const;
export type TargetProduct = typeof targetProducts[number];

export interface TargetProfile {
  readonly product: TargetProduct;
  readonly appId: "dev.brainpet.app" | "dev.openpets.app";
  readonly discoveryPath: string;
  readonly runtimeMarkerPath: string;
  readonly updateChannel: "hmhm2333/brainpet" | "alvinunreal/openpets";
  readonly adapterVersion: "1.0.0";
}

export function resolveTargetProfile(
  product: TargetProduct,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): TargetProfile {
  if (!targetProducts.includes(product)) throw new TypeError(`Unsupported companion target product: ${String(product)}`);
  const productDirectory = product === "brainpet" ? "BrainPet" : "OpenPets";
  const runtimeDirectory = product === "brainpet" ? "brainpet" : "openpets";
  const discoveryPath = environment.OPENPETS_DISCOVERY_FILE ?? resolveDiscoveryPath(platform, environment, homeDirectory, productDirectory, runtimeDirectory);
  return {
    product,
    appId: product === "brainpet" ? "dev.brainpet.app" : "dev.openpets.app",
    discoveryPath,
    runtimeMarkerPath: resolveRuntimeMarkerPath(platform, environment, homeDirectory, productDirectory),
    updateChannel: product === "brainpet" ? "hmhm2333/brainpet" : "alvinunreal/openpets",
    adapterVersion: "1.0.0",
  };
}

export function isTargetProfile(value: unknown): value is TargetProfile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TargetProfile>;
  const product = candidate.product;
  if (!targetProducts.includes(product as TargetProduct)) return false;
  const expectedAppId = product === "brainpet" ? "dev.brainpet.app" : "dev.openpets.app";
  const expectedUpdateChannel = product === "brainpet" ? "hmhm2333/brainpet" : "alvinunreal/openpets";
  return candidate.appId === expectedAppId
    && typeof candidate.discoveryPath === "string" && candidate.discoveryPath.length > 0
    && typeof candidate.runtimeMarkerPath === "string" && candidate.runtimeMarkerPath.length > 0
    && candidate.updateChannel === expectedUpdateChannel
    && candidate.adapterVersion === "1.0.0";
}

function resolveDiscoveryPath(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, homeDirectory: string, productDirectory: string, runtimeDirectory: string): string {
  if (platform === "darwin") return join(homeDirectory, "Library", "Application Support", productDirectory, "runtime", "ipc.json");
  if (platform === "win32") return join(environment.APPDATA ?? join(homeDirectory, "AppData", "Roaming"), productDirectory, "runtime", "ipc.json");
  const xdgRuntime = getSecureXdgRuntimeDir(environment.XDG_RUNTIME_DIR);
  if (xdgRuntime) return join(xdgRuntime, runtimeDirectory, "ipc.json");
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
