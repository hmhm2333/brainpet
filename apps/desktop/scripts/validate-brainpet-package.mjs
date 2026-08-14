#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetReleaseTargets } from "../../../scripts/brainpet-release-contract.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const unpackedNames = {
  "windows-x64": "win-unpacked",
  "windows-arm64": "win-arm64-unpacked",
  "macos-x64": "mac",
  "macos-arm64": "mac-arm64",
  "linux-x64": "linux-unpacked",
  "linux-arm64": "linux-arm64-unpacked",
};

export function validateBrainPetPackage({ outputRoot, targetId }) {
  const target = brainPetReleaseTargets.find((candidate) => candidate.id === targetId);
  assert.ok(target, `Unknown BrainPet package target: ${targetId}`);
  const resolvedOutput = resolve(outputRoot);
  const relativeOutput = relative(appDir, resolvedOutput);
  assert.ok(relativeOutput && !relativeOutput.startsWith(".."), "BrainPet package validation is limited to the desktop app directory.");
  const unpackedRoot = join(resolvedOutput, unpackedNames[targetId]);
  assert.ok(existsSync(unpackedRoot), `BrainPet unpacked output is missing: ${unpackedNames[targetId]}`);
  assert.ok(lstatSync(unpackedRoot).isDirectory(), "BrainPet unpacked output must be a directory.");

  const appRoot = target.platform === "macos" ? join(unpackedRoot, "BrainPet.app", "Contents") : unpackedRoot;
  const resources = join(appRoot, "Resources");
  const executable = target.platform === "windows"
    ? join(appRoot, "brainpet.exe")
    : target.platform === "macos"
      ? join(appRoot, "MacOS", "brainpet")
      : join(appRoot, "brainpet");
  assert.ok(existsSync(executable), `BrainPet executable is missing: ${executable}`);
  assert.ok(existsSync(join(resources, "app.asar")), "BrainPet app.asar is missing.");
  assert.ok(!existsSync(join(appRoot, target.platform === "windows" ? "openpets.exe" : "openpets")), "BrainPet package must not retain the OpenPets executable identity.");

  const bridge = join(resources, "integrations", "codex", "brainpet-codex-bridge");
  for (const path of [".codex-plugin/plugin.json", "brainpet.bridge.json", "hooks/hooks.json", "scripts/bridge.cmd", "scripts/bridge.sh"]) {
    assert.ok(existsSync(join(bridge, path)), `Bundled Codex Bridge source is missing: ${path}`);
  }
  assert.ok(!existsSync(join(resources, "plugins", "official")), "BrainPet packages must not seed OpenPets official plugins.");

  const receipt = {
    schemaVersion: 1,
    target: target.id,
    product: "brainpet",
    appId: "dev.brainpet.app",
    executable: relative(resolvedOutput, executable).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
    bridgeSourceBundled: true,
    nativeBridgeHelpersBundled: false,
    publicReleaseReady: false,
    note: "Unpacked private-test receipt. Public release still requires signed runtime and an independently validated six-helper Bridge artifact.",
  };
  writeFileSync(join(resolvedOutput, `brainpet-package-receipt-${target.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

function parseArgs(argv) {
  let outputRoot = join(appDir, "dist-brainpet");
  let targetId;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") outputRoot = argv[++index];
    else if (argv[index] === "--target") targetId = argv[++index];
    else throw new Error(`Unknown package validation argument: ${argv[index]}`);
  }
  if (!targetId) throw new Error("Usage: validate-brainpet-package.mjs --target <release-target> [--output <directory>]");
  return { outputRoot, targetId };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = validateBrainPetPackage(parseArgs(process.argv.slice(2)));
    console.log(`BrainPet package validation passed (${receipt.target}, publicReleaseReady=${receipt.publicReleaseReady}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
