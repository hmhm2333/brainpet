#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetReleaseTargets } from "../../../scripts/brainpet-release-contract.mjs";
import { assertBrainPetBinary, inspectExecutableBinary } from "../../../scripts/brainpet-binary-format.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const unpackedNames = {
  "windows-x64": "win-unpacked",
  "windows-arm64": "win-arm64-unpacked",
  "macos-x64": "mac",
  "macos-arm64": "mac-arm64",
  "linux-x64": "linux-unpacked",
  "linux-arm64": "linux-arm64-unpacked",
};

export function validateBrainPetPackage({ outputRoot, targetId, mode = "private-test", provenancePath }) {
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
  assertBrainPetBinary(readFileSync(executable), target, `BrainPet runtime ${target.id}`);
  const appAsar = join(resources, "app.asar");
  assert.ok(existsSync(appAsar), "BrainPet app.asar is missing.");
  const appPackage = readAsarPackageJson(appAsar);
  for (const preload of ["pet-preload.cjs", "brainpet-preload.cjs", "brainpet-setup-preload.cjs"]) {
    assertAsarFile(appAsar, preload, `BrainPet package is missing required host preload ${preload}.`);
  }
  assert.deepEqual(appPackage.brainpetDistribution, { profile: "brainpet", appId: "dev.brainpet.app" }, "Packaged runtime identity must be embedded in app.asar.");
  assert.ok(!existsSync(join(appRoot, target.platform === "windows" ? "openpets.exe" : "openpets")), "BrainPet package must not retain the OpenPets executable identity.");

  const bridge = join(resources, "integrations", "codex", "brainpet-codex-bridge");
  for (const path of [".codex-plugin/plugin.json", "brainpet.bridge.json", "hooks/hooks.json", "scripts/bridge.cmd", "scripts/bridge.sh"]) {
    assert.ok(existsSync(join(bridge, path)), `Bundled Codex Bridge source is missing: ${path}`);
  }
  const officialPluginsRoot = join(resources, "plugins", "official");
  assert.equal(existsSync(officialPluginsRoot), false, "BrainPet packages must not bundle the removed training facade or any OpenPets plugin runtime payload.");

  const installerArtifacts = findInstallerArtifacts(resolvedOutput, target);
  const installerValidated = installerArtifacts.length > 0;
  const artifactRecords = installerArtifacts.map((artifact) => validateInstallerArtifact(artifact, target));
  if (mode === "public-release") assert.ok(installerValidated, `Public ${target.id} release requires a concrete installer artifact.`);
  const signatureValidated = mode === "public-release" ? validatePublicSignature({ appRoot, executable, artifacts: installerArtifacts, target, provenancePath }) : false;
  const runtimeReleaseReady = mode === "public-release" && installerValidated && signatureValidated;
  const receipt = {
    schemaVersion: 1,
    target: target.id,
    product: "brainpet",
    appId: appPackage.brainpetDistribution.appId,
    releaseMode: mode,
    executable: relative(resolvedOutput, executable).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
    bridgeSourceBundled: true,
    nativeBridgeHelpersBundled: false,
    installers: artifactRecords,
    installerValidated,
    signatureValidated,
    runtimeReleaseReady,
    publicReleaseReady: false,
    note: mode === "public-release" ? "Runtime and installer passed their platform gate. Aggregate public release readiness still requires the independently validated native Bridge release." : "Private-test runtime; not eligible for public release.",
  };
  writeFileSync(join(resolvedOutput, `brainpet-package-receipt-${target.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

function parseArgs(argv) {
  let mode = "private-test";
  let outputRoot;
  let targetId;
  let provenancePath;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") outputRoot = argv[++index];
    else if (argv[index] === "--target") targetId = argv[++index];
    else if (argv[index] === "--mode") mode = argv[++index];
    else if (argv[index] === "--provenance") provenancePath = argv[++index];
    else throw new Error(`Unknown package validation argument: ${argv[index]}`);
  }
  if (!targetId) throw new Error("Usage: validate-brainpet-package.mjs --target <release-target> [--output <directory>]");
  if (!["private-test", "public-release"].includes(mode)) throw new Error(`Invalid package validation mode: ${mode}`);
  return { outputRoot: outputRoot ?? join(appDir, "dist-brainpet", mode), targetId, mode, provenancePath };
}

function readAsarPackageJson(appAsar) {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const asar = builderRequire("@electron/asar");
  return JSON.parse(asar.extractFile(appAsar, "package.json").toString("utf8"));
}

function assertAsarFile(appAsar, path, message) {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const asar = builderRequire("@electron/asar");
  assert.doesNotThrow(() => asar.extractFile(appAsar, path), message);
}

function findInstallerArtifacts(outputRoot, target) {
  const names = readdirSync(outputRoot, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const selected = target.platform === "windows"
    ? names.filter((name) => /-setup\.exe$/i.test(name) && name.toLowerCase().includes(`-${target.arch}-`))
    : target.platform === "macos"
      ? names.filter((name) => /\.dmg$/i.test(name) && name.toLowerCase().includes(`-${target.arch}.`))
      : names.filter((name) => /\.(appimage|deb)$/i.test(name) && name.toLowerCase().includes(`-${target.arch}.`));
  return selected.map((name) => join(outputRoot, name));
}

function validateInstallerArtifact(path, target) {
  const bytes = readFileSync(path);
  assert.ok(bytes.length >= 16 * 1024, `Installer artifact is implausibly small: ${path}`);
  if (target.platform === "windows") assert.equal(inspectExecutableBinary(bytes).format, "pe", "Windows installer must be a structurally valid PE executable.");
  else if (target.platform === "macos") assert.equal(bytes.toString("ascii", bytes.length - 512, bytes.length - 508), "koly", "macOS installer must contain a valid UDIF trailer.");
  else if (/\.appimage$/i.test(path)) assert.equal(inspectExecutableBinary(bytes).format, "elf", "Linux AppImage must be a structurally valid ELF executable.");
  else assert.equal(bytes.toString("ascii", 0, 8), "!<arch>\n", "Linux deb must be an ar archive.");
  return { path: path.replaceAll("\\", "/"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function validatePublicSignature({ appRoot, executable, artifacts, target, provenancePath }) {
  if (target.platform === "windows") {
    for (const path of [executable, ...artifacts]) {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${path.replaceAll("'", "''")}').Status`], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr || "Authenticode validation failed to run.");
      assert.equal(result.stdout.trim(), "Valid", `BrainPet Authenticode signature is not valid for ${path}: ${result.stdout.trim()}`);
    }
    return true;
  }
  if (target.platform === "macos") {
    const appBundle = appRoot.endsWith("Contents") ? dirname(appRoot) : appRoot;
    const result = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appBundle], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || "BrainPet code signature is invalid.");
    for (const artifact of artifacts) {
      const assessment = spawnSync("spctl", ["--assess", "--type", "install", "--verbose=2", artifact], { encoding: "utf8" });
      assert.equal(assessment.status, 0, assessment.stderr || "BrainPet notarized installer assessment failed.");
    }
    return true;
  }
  assert.ok(provenancePath, "Public Linux release requires --provenance <attestation.json>.");
  const provenance = JSON.parse(readFileSync(resolve(provenancePath), "utf8"));
  assert.equal(provenance.target, target.id, "Linux provenance target mismatch.");
  assert.equal(typeof provenance.builderIdentity, "string", "Linux provenance requires a builder identity.");
  assert.deepEqual(provenance.artifacts, artifacts.map((path) => ({ name: path.split(/[\\/]/).at(-1), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") })), "Linux provenance artifact hashes do not match.");
  return true;
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
