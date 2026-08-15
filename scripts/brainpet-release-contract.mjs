import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const brainPetDistributionContract = Object.freeze(JSON.parse(readFileSync(resolve(root, "config", "brainpet-distribution.json"), "utf8")));
export const brainPetReleaseTargets = Object.freeze(brainPetDistributionContract.releaseTargets.map((target) => Object.freeze({ ...target })));

export const brainPetReleaseTargetIds = Object.freeze(brainPetReleaseTargets.map((target) => target.id));

export function getBrainPetReleaseTarget(platform, arch) {
  const target = brainPetReleaseTargets.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  if (!target) throw new Error(`Unsupported BrainPet release target: ${platform}-${arch}`);
  return target;
}

export function resolveHostBrainPetReleaseTarget(platform = process.platform, arch = process.arch) {
  const normalizedPlatform = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform;
  return getBrainPetReleaseTarget(normalizedPlatform, arch);
}
