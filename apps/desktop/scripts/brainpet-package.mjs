#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getBrainPetReleaseTarget, resolveHostBrainPetReleaseTarget } from "../../../scripts/brainpet-release-contract.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const electronDist = dirname(require("electron"));
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js");

export function parseBrainPetPackageArgs(argv) {
  const options = { target: "installer", dryRun: false, unsignedPrivate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--platform") options.platform = argv[++index];
    else if (value === "--arch") options.arch = argv[++index];
    else if (value === "--target") options.target = argv[++index];
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--unsigned-private") options.unsignedPrivate = true;
    else throw new Error(`Unknown BrainPet package argument: ${value}`);
  }
  if (!["installer", "portable", "dir"].includes(options.target)) throw new Error(`Unsupported BrainPet package target: ${options.target}`);
  const releaseTarget = options.platform || options.arch
    ? getBrainPetReleaseTarget(options.platform ?? resolveHostBrainPetReleaseTarget().platform, options.arch ?? process.arch)
    : resolveHostBrainPetReleaseTarget();
  if (options.target === "portable" && releaseTarget.platform !== "windows") throw new Error("BrainPet portable packages are Windows-only.");
  return { ...options, releaseTarget };
}

export function createBrainPetBuilderInvocation(options) {
  const { releaseTarget } = options;
  const args = [
    electronBuilderCli,
    `--${releaseTarget.electronPlatform}`,
    `--${releaseTarget.arch}`,
    "--config",
    "electron-builder.brainpet.yml",
    `--config.electronDist=${electronDist}`,
  ];
  if (options.target === "dir") args.push("--dir");
  else if (options.target === "portable") args.push("portable");
  if (options.unsignedPrivate && releaseTarget.platform === "windows") args.push("--config.win.signAndEditExecutable=false", "--config.win.verifyUpdateCodeSignature=false");
  return { command: process.execPath, args, cwd: appDir };
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
    process.stdout.write(`${JSON.stringify({ ...invocation, releaseTarget: options.releaseTarget, signedPublicArtifact: !options.unsignedPrivate }, null, 2)}\n`);
    return;
  }
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
