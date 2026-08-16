#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract, getBrainPetReleaseTarget, resolveHostBrainPetReleaseTarget } from "../../../scripts/brainpet-release-contract.mjs";
import { assertBrainPetBinary } from "../../../scripts/brainpet-binary-format.mjs";
import { validateBrainPetPackage } from "./validate-brainpet-package.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const repoRoot = resolve(appDir, "..", "..");
const stagingMarketplaceRoot = join(appDir, ".brainpet-package", "marketplace");
const require = createRequire(import.meta.url);
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js");

export function parseBrainPetPackageArgs(argv) {
  const options = { target: "installer", dryRun: false, mode: "private-test" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--platform") options.platform = argv[++index];
    else if (value === "--arch") options.arch = argv[++index];
    else if (value === "--target") options.target = argv[++index];
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--mode") options.mode = argv[++index];
    else if (value === "--helper") options.helperPath = argv[++index];
    else if (value === "--output") options.outputRoot = argv[++index];
    else if (value === "--app-version") options.appVersion = argv[++index];
    else if (value === "--provenance") throw new Error("--provenance was removed from packaging; Sigstore provenance is created and validated by the aggregate release gate.");
    else if (value === "--defer-trust") throw new Error("--defer-trust was removed: unsigned direct releases validate signature absence during packaging and add Sigstore provenance during aggregation.");
    else throw new Error(`Unknown BrainPet package argument: ${value}`);
  }
  if (!["installer", "portable", "dir"].includes(options.target)) throw new Error(`Unsupported BrainPet package target: ${options.target}`);
  if (!["private-test", "public-release"].includes(options.mode)) throw new Error(`Unsupported BrainPet package mode: ${options.mode}`);
  const releaseTarget = options.platform || options.arch
    ? getBrainPetReleaseTarget(options.platform ?? resolveHostBrainPetReleaseTarget().platform, options.arch ?? process.arch)
    : resolveHostBrainPetReleaseTarget();
  if (options.target === "portable" && releaseTarget.platform !== "windows") throw new Error("BrainPet portable packages are Windows-only.");
  if (options.appVersion && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.appVersion)) throw new Error("BrainPet package version override must be valid SemVer.");
  const outputRoot = resolve(options.outputRoot ?? join(appDir, "dist-brainpet", options.mode));
  const relativeOutput = outputRoot.startsWith(`${appDir}\\`) || outputRoot.startsWith(`${appDir}/`);
  if (!relativeOutput) throw new Error("BrainPet package output must stay inside the desktop app directory.");
  return { ...options, outputRoot, releaseTarget };
}

export function createBrainPetBuilderInvocation(options) {
  const { releaseTarget } = options;
  const electronDist = resolveBrainPetElectronDist(options);
  const platformArgs = [`--${releaseTarget.electronPlatform}`];
  if (options.target === "portable") platformArgs.push("portable");
  else if (options.target === "installer" && releaseTarget.platform === "windows") platformArgs.push("nsis");
  else if (options.target === "installer" && releaseTarget.platform === "macos") platformArgs.push("dmg");
  else if (options.target === "installer") platformArgs.push("AppImage", "deb");
  const args = [
    electronBuilderCli,
    ...platformArgs,
    `--${releaseTarget.arch}`,
    "--config",
    options.mode === "public-release" ? "electron-builder.brainpet.public.yml" : "electron-builder.brainpet.private.yml",
    `--config.electronDist=${electronDist}`,
    `--config.directories.output=${options.outputRoot}`,
  ];
  if (options.appVersion) args.push(`--config.extraMetadata.version=${options.appVersion}`);
  if (options.target === "dir") args.push("--dir");
  return { command: process.execPath, args, cwd: appDir };
}

export function resolveBrainPetElectronDist(options, loadElectron = () => require("electron")) {
  if (options.dryRun) return join(appDir, "node_modules", "electron", "dist");
  return dirname(loadElectron());
}

export function validatePublicReleaseEnvironment(releaseTarget) {
  if (!releaseTarget) throw new Error("Public direct release requires an explicit release target.");
  const policy = brainPetDistributionContract.releasePolicy;
  if (policy?.channel !== "direct-download"
    || policy.platformSignatureStatus !== "absent-by-policy"
    || policy.userConsentRequired !== true
    || policy.storeRegistrationRequired !== false
    || policy.publisherRegistrationRequired !== false
    || policy.provenance !== "sigstore-keyless") {
    throw new Error("Public direct release policy is missing or unsafe.");
  }
  return policy;
}

export function resolveBrainPetHelperArtifact(options) {
  const { releaseTarget } = options;
  const candidates = [
    options.helperPath ? resolve(options.helperPath) : null,
    join(repoRoot, "native", "brainpet-hook", "target", releaseTarget.rustTarget, "release", releaseTarget.helperName),
    join(repoRoot, "native", "brainpet-hook", "target", "release", releaseTarget.helperName),
  ].filter(Boolean);
  const helperPath = candidates.find((candidate) => existsSync(candidate));
  if (!helperPath) throw new Error(`BrainPet package requires the ${releaseTarget.id} native helper. Build it or pass --helper <path>. Checked: ${candidates.join(", ")}`);
  const stat = lstatSync(helperPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`BrainPet helper must be a regular file: ${helperPath}`);
  assertBrainPetBinary(readFileSync(helperPath), releaseTarget, `BrainPet package helper ${releaseTarget.id}`);
  return helperPath;
}

export function prepareBrainPetBundledMarketplace(options) {
  const { releaseTarget } = options;
  const helperPath = resolveBrainPetHelperArtifact(options);
  const sourceRoot = join(repoRoot, "integrations", "codex");
  const sourcePluginRoot = join(sourceRoot, "plugins", "brainpet-codex-bridge");
  const pluginRoot = join(stagingMarketplaceRoot, "plugins", "brainpet-codex-bridge");
  const stagedHelper = join(pluginRoot, "bin", releaseTarget.id, releaseTarget.helperName);
  rmSync(stagingMarketplaceRoot, { recursive: true, force: true });
  mkdirSync(pluginRoot, { recursive: true });
  cpSync(join(sourceRoot, ".agents"), join(stagingMarketplaceRoot, ".agents"), { recursive: true });
  for (const path of [".codex-plugin/plugin.json", "assets/brainpet-plugin-icon.svg", "brainpet.bridge.json", "hooks/hooks.json", "scripts/bridge.cmd", "scripts/bridge.sh"]) {
    const source = join(sourcePluginRoot, path);
    const destination = join(pluginRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  mkdirSync(dirname(stagedHelper), { recursive: true });
  cpSync(helperPath, stagedHelper);
  if (releaseTarget.platform !== "windows") {
    chmodSync(stagedHelper, 0o755);
    chmodSync(join(pluginRoot, "scripts", "bridge.sh"), 0o755);
  }
  const helperBytes = readFileSync(stagedHelper);
  const receipt = {
    schemaVersion: 1,
    product: "brainpet",
    target: releaseTarget.id,
    bridgeVersion: JSON.parse(readFileSync(join(pluginRoot, "brainpet.bridge.json"), "utf8")).bridgeVersion,
    helper: {
      path: `plugins/brainpet-codex-bridge/bin/${releaseTarget.id}/${releaseTarget.helperName}`,
      bytes: helperBytes.length,
      sha256: createHash("sha256").update(helperBytes).digest("hex"),
    },
    nodeFallbackBundled: false,
  };
  writeFileSync(join(stagingMarketplaceRoot, "brainpet-bundle.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { stagingMarketplaceRoot, helperPath, receipt };
}

function findCachedTool(cacheName, marker) {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  const root = join(localAppData, "electron-builder", "Cache", cacheName);
  if (!existsSync(root)) return undefined;
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .find((candidate) => existsSync(join(candidate, marker)));
}

async function main() {
  const options = parseBrainPetPackageArgs(process.argv.slice(2));
  const invocation = createBrainPetBuilderInvocation(options);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ ...invocation, releaseTarget: options.releaseTarget, releaseMode: options.mode, publicArtifact: options.mode === "public-release", helperRequired: true, helperPath: options.helperPath ? resolve(options.helperPath) : null, outputRoot: options.outputRoot, validatorAutomatic: true }, null, 2)}\n`);
    return;
  }
  if (options.mode === "public-release") validatePublicReleaseEnvironment(options.releaseTarget);
  rmSync(options.outputRoot, { recursive: true, force: true });
  prepareBrainPetBundledMarketplace(options);
  const nsisDir = findCachedTool("nsis-3.0.4.1", join("Bin", "makensis.exe"));
  const nsisResourcesDir = findCachedTool("nsis-resources-3.4.1", join("plugins", "x86-unicode"));
  await new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env, ...(nsisDir ? { ELECTRON_BUILDER_NSIS_DIR: nsisDir } : {}), ...(nsisResourcesDir ? { ELECTRON_BUILDER_NSIS_RESOURCES_DIR: nsisResourcesDir } : {}) },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`electron-builder terminated by ${signal}`)) : code === 0 ? resolvePromise() : reject(new Error(`electron-builder exited with ${code ?? "unknown"}`)));
  });
  const receipt = validateBrainPetPackage({
    outputRoot: options.outputRoot,
    targetId: options.releaseTarget.id,
    mode: options.mode,
    packageTarget: options.target,
  });
  console.log(`BrainPet package and automatic validation passed (${receipt.target}, publicReleaseReady=${receipt.publicReleaseReady}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
