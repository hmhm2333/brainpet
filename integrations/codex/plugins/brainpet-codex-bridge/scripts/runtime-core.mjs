import { posix, win32 } from "node:path";

import { brainPetTarget, connectAttemptMs, hookDeadlineMs, runtimePollIntervalMs } from "./generated-contract.mjs";

export { connectAttemptMs, hookDeadlineMs, runtimePollIntervalMs } from "./generated-contract.mjs";

export function remainingDeadlineMs(deadline, now = Date.now()) {
  return Math.max(0, deadline - now);
}

export function shouldWakeRuntime(event) {
  return event?.state !== "idle";
}

export function getRuntimePaths(platform, environment, homeDirectory) {
  if (environment.OPENPETS_DISCOVERY_FILE) {
    return { explicitDiscovery: environment.OPENPETS_DISCOVERY_FILE, brainPetDiscovery: null, installMarker: null };
  }
  if (platform === "win32") {
    const roaming = environment.APPDATA ?? win32.join(homeDirectory, "AppData", "Roaming");
    const local = environment.LOCALAPPDATA ?? win32.join(homeDirectory, "AppData", "Local");
    return {
      explicitDiscovery: null,
      brainPetDiscovery: win32.join(roaming, brainPetTarget.productDirectory, "runtime", "ipc.json"),
      installMarker: win32.join(local, brainPetTarget.productDirectory, "runtime-install.json"),
    };
  }
  if (platform === "darwin") {
    return {
      explicitDiscovery: null,
      brainPetDiscovery: posix.join(homeDirectory, "Library", "Application Support", brainPetTarget.productDirectory, "runtime", "ipc.json"),
      installMarker: posix.join(homeDirectory, "Library", "Application Support", brainPetTarget.productDirectory, "runtime-install.json"),
    };
  }
  const config = environment.XDG_CONFIG_HOME ?? posix.join(homeDirectory, ".config");
  const runtime = environment.XDG_RUNTIME_DIR;
  return {
    explicitDiscovery: null,
    brainPetDiscovery: runtime ? posix.join(runtime, brainPetTarget.runtimeNamespace, "ipc.json") : posix.join(config, brainPetTarget.productDirectory, "runtime", "ipc.json"),
    installMarker: posix.join(config, brainPetTarget.productDirectory, "runtime-install.json"),
  };
}

export function validateInstallMarker(value, platform) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.product !== "brainpet" || value.platform !== platform) throw new Error("Invalid BrainPet install marker.");
  const pathApi = platform === "win32" ? win32 : posix;
  if (typeof value.executablePath !== "string" || !pathApi.isAbsolute(value.executablePath) || value.executablePath.length > 4096 || /[\0\r\n]/.test(value.executablePath)) throw new Error("Invalid BrainPet executable path.");
  const executableName = pathApi.basename(value.executablePath).toLowerCase();
  const validLinuxName = executableName === "brainpet" || /^brainpet(?:[-_.][a-z0-9._-]+)?\.appimage$/i.test(executableName);
  const validName = platform === "win32" ? executableName === "brainpet.exe" : platform === "linux" ? validLinuxName : executableName === "brainpet";
  if (!validName) throw new Error("Invalid BrainPet executable name.");
  if (typeof value.appVersion !== "string" || value.appVersion.length < 1 || value.appVersion.length > 64) throw new Error("Invalid BrainPet version.");
  if (!["stable", "beta", "dev"].includes(value.channel)) throw new Error("Invalid BrainPet release channel.");
  if (typeof value.arch !== "string" || !/^[a-z0-9_-]{2,32}$/i.test(value.arch)) throw new Error("Invalid BrainPet architecture.");
  if (typeof value.writtenAt !== "number" || !Number.isSafeInteger(value.writtenAt) || value.writtenAt <= 0) throw new Error("Invalid BrainPet marker timestamp.");
  return { executablePath: value.executablePath, appVersion: value.appVersion, channel: value.channel, arch: value.arch };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
