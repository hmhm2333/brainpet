#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
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
const workspacePackageNames = Object.freeze([
  "adapter-core", "agent-events", "claude", "cli", "client", "cursor", "install-pet", "mcp", "opencode", "pet-format", "pi", "sdk",
]);
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

export function resolveBrainPetElectronDist(
  options,
  resolveElectronPackage = () => require.resolve("electron/package.json"),
  loadElectron = () => require("electron"),
  pathExists = existsSync,
) {
  const electronDist = join(dirname(resolveElectronPackage()), "dist");
  if (options.dryRun) return electronDist;

  const executable = options.releaseTarget.platform === "windows"
    ? join(electronDist, "electron.exe")
    : options.releaseTarget.platform === "macos"
      ? join(electronDist, "Electron.app", "Contents", "MacOS", "Electron")
      : join(electronDist, "electron");
  if (!pathExists(executable)) loadElectron();
  if (!pathExists(executable)) throw new Error(`Electron distribution is incomplete for ${options.releaseTarget.id}: ${executable}`);
  return electronDist;
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

export function assertCanonicalPackageInputsTracked() {
  const inputs = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "apps/desktop/assets",
    "apps/desktop/build/brainpet-installer.nsh",
    "apps/desktop/src",
    "apps/desktop/pet-preload.cjs",
    "apps/desktop/brainpet-preload.cjs",
    "apps/desktop/brainpet-setup-preload.cjs",
    "apps/desktop/package.json",
    "apps/desktop/postcss.config.cjs",
    "apps/desktop/tailwind.config.cjs",
    "apps/desktop/tsconfig.json",
    "apps/desktop/tsconfig.renderer.json",
    "apps/desktop/vite.config.ts",
    "apps/desktop/electron-builder.brainpet.base.yml",
    "apps/desktop/electron-builder.brainpet.private.yml",
    "apps/desktop/electron-builder.brainpet.public.yml",
    "apps/desktop/scripts/brainpet-strip-macos-signatures.cjs",
    "integrations/codex",
    "native/brainpet-hook/src",
    "native/brainpet-hook/Cargo.toml",
    "native/brainpet-hook/Cargo.lock",
    ...workspacePackageNames.flatMap((name) => [
      `packages/${name}/src`,
      `packages/${name}/package.json`,
      `packages/${name}/tsconfig.json`,
      `packages/${name}/tsconfig.tests.json`,
    ]),
  ];
  const generatedPathExclusions = workspacePackageNames.flatMap((name) => [
    `:(exclude)packages/${name}/dist/**`,
    `:(exclude)packages/${name}/.test-dist/**`,
    `:(exclude)packages/${name}/node_modules/**`,
  ]);
  const packageRoots = workspacePackageNames.map((name) => `packages/${name}`);
  for (const ignored of [false, true]) {
    const args = ["ls-files", "--others", ...(ignored ? ["--ignored"] : []), "--exclude-standard", "--", ...inputs, ...packageRoots, ...generatedPathExclusions];
    const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || "Unable to inspect canonical BrainPet package inputs.");
    const unexpected = result.stdout.split(/\r?\n/).filter(Boolean);
    if (unexpected.length > 0) throw new Error(`BrainPet package inputs contain untracked${ignored ? " ignored" : ""} files: ${unexpected.join(", ")}`);
  }
}

async function prepareFreshPackageInputs(options) {
  for (const name of ["dist", ".test-dist", ".brainpet-package"]) rmSync(join(appDir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  for (const name of workspacePackageNames) {
    const packageRoot = join(repoRoot, "packages", name);
    for (const output of ["dist", ".test-dist"]) rmSync(join(packageRoot, output), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  assertCanonicalPackageInputsTracked();
  await runCommand(
    process.platform === "win32" ? "cmd.exe" : "pnpm",
    process.platform === "win32" ? ["/d", "/s", "/c", "pnpm.cmd", "--filter", "@open-pets/desktop", "build"] : ["--filter", "@open-pets/desktop", "build"],
    repoRoot,
    process.env,
    "BrainPet desktop build",
  );
  if (!options.helperPath) {
    await runCommand(process.platform === "win32" ? "cargo.exe" : "cargo", ["build", "--locked", "--release", "--manifest-path", join(repoRoot, "native", "brainpet-hook", "Cargo.toml"), "--target", options.releaseTarget.rustTarget], repoRoot, process.env, `BrainPet native helper build (${options.releaseTarget.id})`);
  }
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
  await prepareFreshPackageInputs(options);
  rmSync(options.outputRoot, { recursive: true, force: true });
  prepareBrainPetBundledMarketplace(options);
  const nsisDir = findCachedTool("nsis-3.0.4.1", join("Bin", "makensis.exe"));
  const nsisResourcesDir = findCachedTool("nsis-resources-3.4.1", join("plugins", "x86-unicode"));
  const builderEnvironment = { ...process.env, ...(nsisDir ? { ELECTRON_BUILDER_NSIS_DIR: nsisDir } : {}), ...(nsisResourcesDir ? { ELECTRON_BUILDER_NSIS_RESOURCES_DIR: nsisResourcesDir } : {}) };
  await runBrainPetElectronBuilder(options, invocation, () => runCommand(invocation.command, invocation.args, invocation.cwd, builderEnvironment, "electron-builder"));
  const receipt = validateBrainPetPackage({
    outputRoot: options.outputRoot,
    targetId: options.releaseTarget.id,
    mode: options.mode,
    packageTarget: options.target,
  });
  console.log(`BrainPet package and automatic validation passed (${receipt.target}, publicReleaseReady=${receipt.publicReleaseReady}).`);
}

export async function runBrainPetElectronBuilder(options, invocation, runOnce, wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))) {
  const attempts = options.releaseTarget.platform === "macos" ? 2 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await runOnce(invocation);
      return;
    } catch (error) {
      lastError = error;
      const transientMacosDmgFailure = /resource busy|couldn'?t eject|unable to detach device cleanly/i.test(error instanceof Error ? error.message : String(error));
      if (attempt === attempts || !transientMacosDmgFailure) break;
      console.warn(`BrainPet macOS packaging attempt ${attempt} failed; retrying once after a clean output reset.`);
      rmSync(options.outputRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await wait(5_000);
    }
  }
  throw lastError;
}

function runCommand(command, args, cwd, env, label) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`${label} terminated by ${signal}.`)) : code === 0 ? resolvePromise() : reject(new Error(`${label} exited with ${code ?? "unknown"}.`)));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
