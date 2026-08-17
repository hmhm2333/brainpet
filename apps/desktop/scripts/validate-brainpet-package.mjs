#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract, brainPetReleaseTargets } from "../../../scripts/brainpet-release-contract.mjs";
import { assertBrainPetBinary, inspectExecutableBinary } from "../../../scripts/brainpet-binary-format.mjs";
import { createBrainPetRuntimeTree } from "./brainpet-runtime-tree.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const unpackedNames = {
  "windows-x64": "win-unpacked",
  "windows-arm64": "win-arm64-unpacked",
  "macos-x64": "mac",
  "macos-arm64": "mac-arm64",
  "linux-x64": "linux-unpacked",
  "linux-arm64": "linux-arm64-unpacked",
};

export function validateBrainPetPackage({ outputRoot, targetId, mode = "private-test", packageTarget = "installer" }) {
  const target = brainPetReleaseTargets.find((candidate) => candidate.id === targetId);
  assert.ok(target, `Unknown BrainPet package target: ${targetId}`);
  assert.ok(["installer", "portable", "dir"].includes(packageTarget), `Unknown BrainPet package artifact target: ${packageTarget}`);
  const resolvedOutput = resolve(outputRoot);
  const relativeOutput = relative(appDir, resolvedOutput);
  assert.ok(relativeOutput && !relativeOutput.startsWith(".."), "BrainPet package validation is limited to the desktop app directory.");
  const unpackedRoot = join(resolvedOutput, unpackedNames[targetId]);
  assert.ok(existsSync(unpackedRoot), `BrainPet unpacked output is missing: ${unpackedNames[targetId]}`);
  assert.ok(lstatSync(unpackedRoot).isDirectory(), "BrainPet unpacked output must be a directory.");

  const appRoot = target.platform === "macos" ? join(unpackedRoot, "BrainPet.app", "Contents") : unpackedRoot;
  const resources = resolveBrainPetResourcesRoot(appRoot, target);
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
  const runtimeTree = createBrainPetRuntimeTree(unpackedRoot);
  for (const preload of ["pet-preload.cjs", "brainpet-preload.cjs", "brainpet-setup-preload.cjs"]) {
    assertAsarFile(appAsar, preload, `BrainPet package is missing required host preload ${preload}.`);
  }
  assert.deepEqual(appPackage.brainpetDistribution, { profile: "brainpet", appId: "dev.brainpet.app" }, "Packaged runtime identity must be embedded in app.asar.");
  assert.ok(!existsSync(join(appRoot, target.platform === "windows" ? "openpets.exe" : "openpets")), "BrainPet package must not retain the OpenPets executable identity.");

  const marketplace = join(resources, "integrations", "codex", "brainpet-marketplace");
  const bridge = join(marketplace, "plugins", "brainpet-codex-bridge");
  assert.ok(existsSync(join(marketplace, ".agents", "plugins", "marketplace.json")), "Bundled BrainPet marketplace manifest is missing.");
  for (const path of [".codex-plugin/plugin.json", "brainpet.bridge.json", "hooks/hooks.json", "scripts/bridge.cmd", "scripts/bridge.sh"]) {
    assert.ok(existsSync(join(bridge, path)), `Bundled Codex Bridge source is missing: ${path}`);
  }
  const bundleReceipt = JSON.parse(readFileSync(join(marketplace, "brainpet-bundle.json"), "utf8"));
  assert.equal(bundleReceipt.target, target.id, "Bundled Bridge target does not match the runtime package.");
  assert.equal(bundleReceipt.nodeFallbackBundled, false, "Packaged Bridge must not rely on Node fallback.");
  const helper = join(bridge, "bin", target.id, target.helperName);
  assert.ok(existsSync(helper), `Packaged native Bridge helper is missing: ${target.id}/${target.helperName}`);
  const helperBytes = readFileSync(helper);
  assertBrainPetBinary(helperBytes, target, `Packaged Bridge helper ${target.id}`);
  assert.equal(createHash("sha256").update(helperBytes).digest("hex"), bundleReceipt.helper.sha256, "Packaged helper hash does not match its bundle receipt.");
  for (const launcher of ["scripts/bridge.cmd", "scripts/bridge.sh"]) {
    assert.doesNotMatch(readFileSync(join(bridge, launcher), "utf8"), /\b(?:node|npm|npx|pnpm)\b\s+["']?[^\r\n]*bridge\.mjs/i, `Packaged ${launcher} must not contain a Node fallback.`);
  }
  if (target.nodePlatform === process.platform && target.arch === process.arch) {
    const selfTest = spawnSync(helper, ["--self-test"], { encoding: "utf8", timeout: 2_000, windowsHide: true });
    assert.equal(selfTest.status, 0, selfTest.error?.message || selfTest.stderr || "Packaged native helper self-test failed.");
    assert.match(selfTest.stdout, /^brainpet-hook \S+ ok/m, "Packaged native helper returned an invalid self-test receipt.");
  }
  const officialPluginsRoot = join(resources, "plugins", "official");
  assert.equal(existsSync(officialPluginsRoot), false, "BrainPet packages must not bundle the removed training facade or any OpenPets plugin runtime payload.");

  const packageArtifacts = findPackageArtifacts(resolvedOutput, target, packageTarget);
  const artifactRecords = packageArtifacts.map((artifact) => validatePackageArtifact(artifact, target, resolvedOutput));
  assertRequiredArtifacts(artifactRecords, target, packageTarget);
  if (mode === "public-release") assertNoUntrackedPublicArtifacts(resolvedOutput, packageArtifacts);
  const installerValidated = packageTarget === "installer" && artifactRecords.length > 0;
  if (mode === "public-release") assert.equal(packageTarget, "installer", `Public ${target.id} releases must produce an installer.`);
  const unsignedPolicyValidated = mode === "public-release"
    ? validateUnsignedPlatformPolicy({ appRoot, executable, artifacts: packageArtifacts, target })
    : false;
  const signatureValidated = false;
  const runtimeReleaseReady = mode === "public-release" && installerValidated && unsignedPolicyValidated;
  const buildIdentity = resolveBuildIdentity();
  const receipt = {
    schemaVersion: 2,
    target: target.id,
    supportLevel: target.supportLevel,
    product: "brainpet",
    appId: appPackage.brainpetDistribution.appId,
    appVersion: appPackage.version,
    releaseMode: mode,
    packageTarget,
    source: buildIdentity,
    executable: relative(resolvedOutput, executable).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
    appAsar: relative(resolvedOutput, appAsar).replaceAll("\\", "/"),
    appAsarSha256: createHash("sha256").update(readFileSync(appAsar)).digest("hex"),
    runtimeTree,
    bridgeSourceBundled: true,
    bridgeMarketplaceBundled: true,
    nativeBridgeHelpersBundled: true,
    nativeBridgeHelperSha256: bundleReceipt.helper.sha256,
    artifacts: artifactRecords,
    installerValidated,
    signatureValidated,
    unsignedPolicyValidated,
    platformSignatureStatus: mode === "public-release" ? "absent-by-policy" : "not-evaluated",
    distributionChannel: mode === "public-release" ? "direct-download" : "private-test",
    userConsentRequired: mode === "public-release",
    publisherRegistrationRequired: false,
    provenanceValidated: false,
    runtimeReleaseReady,
    publicReleaseReady: false,
    note: mode === "public-release"
      ? "Unsigned direct-download runtime and installer passed structure and signature-absence gates. Aggregate readiness still requires Sigstore provenance, Bridge, lifecycle, Adapter and physical user-consent evidence."
      : "Private-test runtime; not eligible for public release.",
  };
  writeFileSync(join(resolvedOutput, `brainpet-package-receipt-${target.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

export function resolveBrainPetResourcesRoot(appRoot, target) {
  return join(appRoot, target.platform === "macos" ? "Resources" : "resources");
}

function parseArgs(argv) {
  let mode = "private-test";
  let outputRoot;
  let targetId;
  let packageTarget = "installer";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") outputRoot = argv[++index];
    else if (argv[index] === "--target") targetId = argv[++index];
    else if (argv[index] === "--mode") mode = argv[++index];
    else if (argv[index] === "--package-target") packageTarget = argv[++index];
    else if (["--provenance", "--allow-pending-trust"].includes(argv[index])) throw new Error(`${argv[index]} was removed from package validation; Sigstore provenance is validated by the aggregate release gate.`);
    else throw new Error(`Unknown package validation argument: ${argv[index]}`);
  }
  if (!targetId) throw new Error("Usage: validate-brainpet-package.mjs --target <release-target> [--output <directory>]");
  if (!["private-test", "public-release"].includes(mode)) throw new Error(`Invalid package validation mode: ${mode}`);
  return { outputRoot: outputRoot ?? join(appDir, "dist-brainpet", mode), targetId, mode, packageTarget };
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

function findPackageArtifacts(outputRoot, target, packageTarget) {
  if (packageTarget === "dir") return [];
  const names = readdirSync(outputRoot, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const matchingArchitecture = (name) => name.toLowerCase().includes(`-${target.arch}-`) || name.toLowerCase().includes(`-${target.arch}.`);
  if (packageTarget === "portable") {
    return names.filter((name) => /\.exe$/i.test(name) && !/-setup\.exe$/i.test(name) && matchingArchitecture(name)).map((name) => ({ path: join(outputRoot, name), kind: "portable" }));
  }
  if (target.platform === "windows") return names.filter((name) => /-setup\.exe$/i.test(name) && matchingArchitecture(name)).map((name) => ({ path: join(outputRoot, name), kind: "nsis" }));
  if (target.platform === "macos") return names.filter((name) => /\.dmg$/i.test(name) && matchingArchitecture(name)).map((name) => ({ path: join(outputRoot, name), kind: "dmg" }));
  return names.filter((name) => /\.(appimage|deb)$/i.test(name) && matchingArchitecture(name)).map((name) => ({ path: join(outputRoot, name), kind: /\.appimage$/i.test(name) ? "appimage" : "deb" }));
}

function validatePackageArtifact(artifact, target, outputRoot) {
  const { path, kind } = artifact;
  const bytes = readFileSync(path);
  assert.ok(bytes.length >= 16 * 1024, `Installer artifact is implausibly small: ${path}`);
  if (target.platform === "windows") assert.equal(inspectExecutableBinary(bytes).format, "pe", "Windows installer must be a structurally valid PE executable.");
  else if (target.platform === "macos") assert.equal(bytes.toString("ascii", bytes.length - 512, bytes.length - 508), "koly", "macOS installer must contain a valid UDIF trailer.");
  else if (/\.appimage$/i.test(path)) assert.equal(inspectExecutableBinary(bytes).format, "elf", "Linux AppImage must be a structurally valid ELF executable.");
  else assert.equal(bytes.toString("ascii", 0, 8), "!<arch>\n", "Linux deb must be an ar archive.");
  return { kind, path: relative(outputRoot, path).replaceAll("\\", "/"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function assertRequiredArtifacts(artifacts, target, packageTarget) {
  if (packageTarget === "dir") return;
  const actual = new Set(artifacts.map((artifact) => artifact.kind));
  const expected = packageTarget === "portable"
    ? ["portable"]
    : target.platform === "windows"
      ? ["nsis"]
      : target.platform === "macos"
        ? ["dmg"]
        : ["appimage", "deb"];
  for (const kind of expected) assert.ok(actual.has(kind), `${target.id} package is missing required ${kind} artifact.`);
}

function assertNoUntrackedPublicArtifacts(outputRoot, artifacts) {
  const tracked = new Set(artifacts.map((artifact) => resolve(artifact.path).toLowerCase()));
  const releaseFiles = readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:exe|dmg|appimage|deb|zip|tar\.(?:gz|xz))$/i.test(entry.name))
    .map((entry) => resolve(outputRoot, entry.name));
  for (const path of releaseFiles) assert.ok(tracked.has(path.toLowerCase()), `Public output contains an untracked distributable artifact: ${path}`);
}

function validateUnsignedPlatformPolicy({ appRoot, executable, artifacts, target }) {
  if (target.platform === "windows") {
    for (const path of [executable, ...artifacts.map((artifact) => artifact.path)]) {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$securityModule = Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'; Import-Module $securityModule -ErrorAction Stop; (Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath '${path.replaceAll("'", "''")}').Status`], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr || "Authenticode validation failed to run.");
      assert.equal(result.stdout.trim(), "NotSigned", `BrainPet direct-release artifact unexpectedly has an Authenticode status for ${path}: ${result.stdout.trim()}`);
    }
    return true;
  }
  if (target.platform === "macos") {
    const appBundle = appRoot.endsWith("Contents") ? dirname(appRoot) : appRoot;
    assertMacosCodeObjectIsUnsigned(spawnSync("codesign", ["--display", "--verbose=4", appBundle], { encoding: "utf8" }), "BrainPet app bundle");
    for (const artifact of artifacts.map((candidate) => candidate.path)) {
      assertMacosCodeObjectIsUnsigned(spawnSync("codesign", ["--display", "--verbose=4", artifact], { encoding: "utf8" }), `BrainPet DMG ${artifact}`);
      const assessment = spawnSync("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", artifact], { encoding: "utf8" });
      assert.equal(assessment.error, undefined, "Unable to run the macOS Gatekeeper probe.");
      assert.ok(Number.isInteger(assessment.status), "macOS Gatekeeper probe did not return an exit status.");
      assert.notEqual(assessment.status, 0, "BrainPet direct-release DMG unexpectedly passed Gatekeeper publisher assessment.");
      const stapler = spawnSync("xcrun", ["stapler", "validate", artifact], { encoding: "utf8" });
      assert.equal(stapler.error, undefined, "Unable to run the macOS notarization-ticket probe.");
      assert.ok(Number.isInteger(stapler.status), "macOS notarization-ticket probe did not return an exit status.");
      assert.notEqual(stapler.status, 0, "BrainPet direct-release DMG unexpectedly contains a valid notarization ticket.");
    }
    return true;
  }
  validateUnsignedLinuxArtifacts(artifacts);
  return true;
}

export function assertMacosCodeObjectIsUnsigned(result, label) {
  assert.equal(result.error, undefined, `Unable to run the macOS code-signature probe for ${label}.`);
  assert.ok(Number.isInteger(result.status), `macOS code-signature probe did not return an exit status for ${label}.`);
  assert.notEqual(result.status, 0, `${label} unexpectedly contains a code signature.`);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.match(output, /code object is not signed at all/i, `${label} did not produce the exact unsigned codesign outcome.`);
  return true;
}

export function validateUnsignedLinuxArtifacts(artifacts, commandRunner = spawnSync) {
  for (const artifact of artifacts) {
    if (artifact.kind === "appimage") {
      const result = commandRunner(artifact.path, ["--appimage-signature"], { encoding: "buffer", timeout: 30_000 });
      assert.equal(result.error, undefined, "Unable to run the AppImage embedded-signature probe.");
      assert.equal(result.status, 0, "AppImage embedded-signature probe failed.");
      const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
      const signatureBytes = [...output].filter((byte) => ![0x00, 0x09, 0x0a, 0x0d, 0x20].includes(byte));
      assert.equal(signatureBytes.length, 0, "BrainPet AppImage unexpectedly contains an embedded signature.");
    } else if (artifact.kind === "deb") {
      const result = commandRunner("ar", ["t", artifact.path], { encoding: "utf8", timeout: 30_000 });
      assert.equal(result.error, undefined, "Unable to run the deb archive-signature probe.");
      assert.equal(result.status, 0, result.stderr || "deb archive-signature probe failed.");
      const members = String(result.stdout ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      assert.equal(members.filter((name) => name === "debian-binary").length, 1, "BrainPet deb must contain exactly one debian-binary member.");
      assert.equal(members.filter((name) => /^control\.tar\.(?:gz|xz|zst|bz2|lzma)$/.test(name)).length, 1, "BrainPet deb must contain exactly one standard control archive.");
      assert.equal(members.filter((name) => /^data\.tar\.(?:gz|xz|zst|bz2|lzma)$/.test(name)).length, 1, "BrainPet deb must contain exactly one standard data archive.");
      assert.equal(members.length, 3, "BrainPet deb unexpectedly contains an embedded signature or non-standard archive member.");
    } else {
      assert.fail(`Unsupported Linux artifact signature probe: ${artifact.kind}`);
    }
  }
  return true;
}

function resolveBuildIdentity() {
  const gitCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: appDir, encoding: "utf8", windowsHide: true });
  const gitStatus = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd: appDir, encoding: "utf8", windowsHide: true });
  return {
    repository: process.env.GITHUB_REPOSITORY ?? brainPetDistributionContract.identity.repository,
    commit: process.env.GITHUB_SHA ?? (gitCommit.status === 0 ? gitCommit.stdout.trim() : "unknown"),
    treeDirty: gitStatus.status === 0 ? gitStatus.stdout.trim().length > 0 : null,
    githubActions: process.env.GITHUB_ACTIONS === "true",
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
  };
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
