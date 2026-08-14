export const brainPetReleaseTargets = Object.freeze([
  { id: "windows-x64", platform: "windows", electronPlatform: "win", arch: "x64", rustTarget: "x86_64-pc-windows-msvc", helperName: "brainpet-hook.exe" },
  { id: "windows-arm64", platform: "windows", electronPlatform: "win", arch: "arm64", rustTarget: "aarch64-pc-windows-msvc", helperName: "brainpet-hook.exe" },
  { id: "macos-x64", platform: "macos", electronPlatform: "mac", arch: "x64", rustTarget: "x86_64-apple-darwin", helperName: "brainpet-hook" },
  { id: "macos-arm64", platform: "macos", electronPlatform: "mac", arch: "arm64", rustTarget: "aarch64-apple-darwin", helperName: "brainpet-hook" },
  { id: "linux-x64", platform: "linux", electronPlatform: "linux", arch: "x64", rustTarget: "x86_64-unknown-linux-gnu", helperName: "brainpet-hook" },
  { id: "linux-arm64", platform: "linux", electronPlatform: "linux", arch: "arm64", rustTarget: "aarch64-unknown-linux-gnu", helperName: "brainpet-hook" },
]);

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
