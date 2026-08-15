import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

export const brainPetInstallMarkerVersion = 1;
export const brainPetReleaseChannels = ["stable", "beta", "dev"] as const;
export type BrainPetReleaseChannel = typeof brainPetReleaseChannels[number];

export interface BrainPetInstallMarker {
  readonly schemaVersion: 1;
  readonly product: "brainpet";
  readonly executablePath: string;
  readonly appVersion: string;
  readonly channel: BrainPetReleaseChannel;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly writtenAt: number;
}

export function getBrainPetInstallMarkerPath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  if (environment.BRAINPET_INSTALL_MARKER_FILE) return environment.BRAINPET_INSTALL_MARKER_FILE;
  if (platform === "win32") return win32.join(environment.LOCALAPPDATA ?? win32.join(homeDirectory, "AppData", "Local"), "BrainPet", "runtime-install.json");
  if (platform === "darwin") return posix.join(homeDirectory, "Library", "Application Support", "BrainPet", "runtime-install.json");
  return posix.join(environment.XDG_CONFIG_HOME ?? posix.join(homeDirectory, ".config"), "BrainPet", "runtime-install.json");
}

export function normalizeBrainPetReleaseChannel(value: unknown): BrainPetReleaseChannel {
  return brainPetReleaseChannels.find((channel) => channel === value) ?? "stable";
}

export function resolveBrainPetMarkerExecutablePath(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "linux" || typeof environment.APPIMAGE !== "string") return executablePath;
  const appImagePath = environment.APPIMAGE;
  if (!posix.isAbsolute(appImagePath) || /[\0\r\n]/.test(appImagePath)) return executablePath;
  return isAllowedBrainPetExecutableName(posix.basename(appImagePath), platform) ? appImagePath : executablePath;
}

export function createBrainPetInstallMarker(input: {
  readonly executablePath: string;
  readonly appVersion: string;
  readonly channel?: unknown;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly writtenAt?: number;
}): BrainPetInstallMarker {
  const platform = input.platform ?? process.platform;
  const marker: BrainPetInstallMarker = {
    schemaVersion: brainPetInstallMarkerVersion,
    product: "brainpet",
    executablePath: input.executablePath,
    appVersion: input.appVersion,
    channel: normalizeBrainPetReleaseChannel(input.channel),
    platform,
    arch: input.arch ?? process.arch,
    writtenAt: input.writtenAt ?? Date.now(),
  };
  return validateBrainPetInstallMarker(marker, platform);
}

export function validateBrainPetInstallMarker(value: unknown, platform: NodeJS.Platform = process.platform): BrainPetInstallMarker {
  if (!isRecord(value) || value.schemaVersion !== brainPetInstallMarkerVersion || value.product !== "brainpet") throw new TypeError("BrainPet install marker identity is invalid.");
  const pathApi = platform === "win32" ? win32 : posix;
  if (typeof value.executablePath !== "string" || !pathApi.isAbsolute(value.executablePath) || value.executablePath.length > 4096 || /[\0\r\n]/.test(value.executablePath)) throw new TypeError("BrainPet executable path is invalid.");
  const executableName = pathApi.basename(value.executablePath);
  if (!isAllowedBrainPetExecutableName(executableName, platform)) throw new TypeError("BrainPet executable name is invalid.");
  if (typeof value.appVersion !== "string" || value.appVersion.length < 1 || value.appVersion.length > 64 || /[\0\r\n]/.test(value.appVersion)) throw new TypeError("BrainPet app version is invalid.");
  if (!brainPetReleaseChannels.includes(value.channel as BrainPetReleaseChannel)) throw new TypeError("BrainPet release channel is invalid.");
  if (value.platform !== platform) throw new TypeError("BrainPet install marker platform is invalid.");
  if (typeof value.arch !== "string" || !/^[a-z0-9_-]{2,32}$/i.test(value.arch)) throw new TypeError("BrainPet architecture is invalid.");
  if (typeof value.writtenAt !== "number" || !Number.isSafeInteger(value.writtenAt) || value.writtenAt <= 0) throw new TypeError("BrainPet install marker timestamp is invalid.");
  return value as unknown as BrainPetInstallMarker;
}

function isAllowedBrainPetExecutableName(value: string, platform: NodeJS.Platform): boolean {
  const executableName = value.toLowerCase();
  if (platform === "win32") return executableName === "brainpet.exe";
  if (platform === "linux") return executableName === "brainpet" || /^brainpet(?:[-_.][a-z0-9._-]+)?\.appimage$/i.test(executableName);
  return executableName === "brainpet";
}

export function writeBrainPetInstallMarker(marker: BrainPetInstallMarker, path = getBrainPetInstallMarkerPath()): string {
  const validated = validateBrainPetInstallMarker(marker);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(path), 0o700); } catch { /* best effort on Windows */ }
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporaryPath, 0o600); } catch { /* best effort on Windows */ }
  renameSync(temporaryPath, path);
  try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
  return path;
}

export function readValidBrainPetInstallMarker(
  path = getBrainPetInstallMarkerPath(),
  platform: NodeJS.Platform = process.platform,
): BrainPetInstallMarker | null {
  try {
    const markerStat = lstatSync(path);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return null;
    const marker = validateBrainPetInstallMarker(JSON.parse(readFileSync(path, "utf8")), platform);
    const executableStat = lstatSync(marker.executablePath);
    if (!executableStat.isFile() || executableStat.isSymbolicLink()) return null;
    return marker;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
