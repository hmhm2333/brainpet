#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract, brainPetReleaseTargets } from "../../../scripts/brainpet-release-contract.mjs";
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

export function validateBrainPetPackage({ outputRoot, targetId, mode = "private-test", packageTarget = "installer", provenancePath, allowPendingTrust = false }) {
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
  const installerValidated = packageTarget === "installer" && artifactRecords.length > 0;
  if (mode === "public-release") assert.equal(packageTarget, "installer", `Public ${target.id} releases must produce an installer.`);
  const signatureValidated = mode === "public-release"
    ? validatePublicTrust({ appRoot, executable, artifacts: packageArtifacts, target, provenancePath, allowPendingTrust })
    : false;
  const runtimeReleaseReady = mode === "public-release" && installerValidated && signatureValidated;
  const buildIdentity = resolveBuildIdentity();
  const receipt = {
    schemaVersion: 1,
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
    bridgeSourceBundled: true,
    bridgeMarketplaceBundled: true,
    nativeBridgeHelpersBundled: true,
    nativeBridgeHelperSha256: bundleReceipt.helper.sha256,
    artifacts: artifactRecords,
    installerValidated,
    signatureValidated,
    runtimeReleaseReady,
    publicReleaseReady: false,
    note: mode === "public-release"
      ? signatureValidated
        ? "Runtime and installer passed their target trust gate. Aggregate public release readiness still requires Bridge, lifecycle, Adapter and physical evidence."
        : "Public artifact structure passed, but target trust evidence is pending; aggregate public release readiness is false."
      : "Private-test runtime; not eligible for public release.",
  };
  writeFileSync(join(resolvedOutput, `brainpet-package-receipt-${target.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

function parseArgs(argv) {
  let mode = "private-test";
  let outputRoot;
  let targetId;
  let packageTarget = "installer";
  let provenancePath;
  let allowPendingTrust = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") outputRoot = argv[++index];
    else if (argv[index] === "--target") targetId = argv[++index];
    else if (argv[index] === "--mode") mode = argv[++index];
    else if (argv[index] === "--package-target") packageTarget = argv[++index];
    else if (argv[index] === "--provenance") provenancePath = argv[++index];
    else if (argv[index] === "--allow-pending-trust") allowPendingTrust = true;
    else throw new Error(`Unknown package validation argument: ${argv[index]}`);
  }
  if (!targetId) throw new Error("Usage: validate-brainpet-package.mjs --target <release-target> [--output <directory>]");
  if (!["private-test", "public-release"].includes(mode)) throw new Error(`Invalid package validation mode: ${mode}`);
  return { outputRoot: outputRoot ?? join(appDir, "dist-brainpet", mode), targetId, mode, packageTarget, provenancePath, allowPendingTrust };
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

function validatePublicTrust({ appRoot, executable, artifacts, target, provenancePath, allowPendingTrust }) {
  if (allowPendingTrust) return false;
  if (target.platform === "windows") {
    for (const path of [executable, ...artifacts.map((artifact) => artifact.path)]) {
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
    const appAssessment = spawnSync("spctl", ["--assess", "--type", "execute", "--verbose=2", appBundle], { encoding: "utf8" });
    assert.equal(appAssessment.status, 0, appAssessment.stderr || "BrainPet signed app assessment failed.");
    for (const artifact of artifacts.map((candidate) => candidate.path)) {
      const assessment = spawnSync("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", artifact], { encoding: "utf8" });
      assert.equal(assessment.status, 0, assessment.stderr || "BrainPet notarized installer assessment failed.");
      const stapler = spawnSync("xcrun", ["stapler", "validate", artifact], { encoding: "utf8" });
      assert.equal(stapler.status, 0, stapler.stderr || "BrainPet notarization ticket is not stapled to the DMG.");
    }
    return true;
  }
  assert.ok(provenancePath, "Public Linux release requires --provenance <GitHub attestation bundle>.");
  const sourceCommit = resolveBuildIdentity().commit;
  assert.match(sourceCommit, /^[a-f0-9]{40}$/i, "Public Linux provenance requires an exact source commit.");
  const repository = brainPetDistributionContract.identity.repository;
  const signerWorkflow = `github.com/${repository}/.github/workflows/brainpet-public-release-gate.yml`;
  for (const artifact of artifacts) {
    const verification = spawnSync("gh", ["attestation", "verify", artifact.path, "--bundle", resolve(provenancePath), "--repo", repository, "--signer-workflow", signerWorkflow, "--source-digest", sourceCommit, "--deny-self-hosted-runners", "--format", "json"], { encoding: "utf8" });
    assert.equal(verification.status, 0, verification.stderr || `GitHub provenance validation failed for ${basename(artifact.path)}.`);
    const verified = JSON.parse(verification.stdout);
    assert.ok(Array.isArray(verified) && verified.length > 0, `GitHub returned no verified provenance for ${basename(artifact.path)}.`);
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
