#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract, brainPetReleaseTargets } from "./brainpet-release-contract.mjs";
import { assertBrainPetBinary, inspectExecutableBinary } from "./brainpet-binary-format.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lifecycleRequirements = Object.freeze([
  { target: "windows-x64", kind: "nsis" },
  { target: "macos-arm64", kind: "dmg" },
  { target: "linux-x64", kind: "appimage" },
  { target: "linux-x64", kind: "deb" },
]);

export function aggregateBrainPetReleaseReceipt(options) {
  const releaseMode = options.releaseMode ?? "private-test";
  assert.ok(["private-test", "public-release"].includes(releaseMode), "Invalid aggregate release mode.");
  const packagesRoot = resolve(options.packagesRoot);
  const lifecycleRoot = resolve(options.lifecycleRoot);
  const bridgeRoot = resolve(options.bridgeRoot);
  const packageReceipts = findFiles(packagesRoot, /^brainpet-package-receipt-[a-z0-9-]+\.json$/);
  const lifecycleReceipts = findFiles(lifecycleRoot, /^brainpet-install-lifecycle-receipt-[a-z0-9-]+-[a-z0-9-]+\.json$/);
  const physicalReceipts = options.physicalRoot && existsSync(resolve(options.physicalRoot))
    ? findFiles(resolve(options.physicalRoot), /^brainpet-physical-receipt\.json$/)
    : [];

  const packages = brainPetReleaseTargets.map((target) => validatePackageReceipt(packageReceipts, packagesRoot, target, releaseMode));
  const appVersions = new Set(packages.map((entry) => entry.appVersion));
  assert.equal(appVersions.size, 1, "All runtime packages must use one exact app version.");
  const appVersion = [...appVersions][0];
  const lifecycle = lifecycleRequirements.map((requirement) => validateLifecycleReceipt(lifecycleReceipts, requirement, packages, releaseMode));
  const bridge = validateBridgeReceipt(bridgeRoot);
  if (releaseMode === "public-release") validateBridgeProvenance(bridgeRoot, bridge);
  const physical = physicalReceipts.map((path) => validatePhysicalReceipt(path));
  const sourceCommits = new Set(packages.map((entry) => entry.source.commit));
  for (const entry of lifecycle) sourceCommits.add(entry.source.commit);
  sourceCommits.add(bridge.source.commit);
  assert.equal(sourceCommits.size, 1, "Release evidence must bind one exact source commit.");
  const sourceCommit = [...sourceCommits][0];
  for (const entry of physical) {
    assert.equal(entry.sourceCommit, sourceCommit, `Physical receipt ${entry.target} is not bound to release commit ${sourceCommit}.`);
    const packageReceipt = packages.find((candidate) => candidate.target === entry.target);
    assert.ok(packageReceipt?.artifacts.some((artifact) => artifact.sha256 === entry.artifactSha256), `Physical receipt ${entry.target} does not reference an aggregated installer artifact.`);
  }

  const missingEvidence = [];
  const stableTargets = brainPetReleaseTargets.filter((target) => target.supportLevel === "stable");
  for (const target of stableTargets) {
    const packageReceipt = packages.find((entry) => entry.target === target.id);
    if (!packageReceipt?.runtimeReleaseReady) missingEvidence.push(`${target.id}:trusted-runtime-package`);
    if (!lifecycle.some((entry) => entry.target === target.id && entry.overallStatus === "passed")) missingEvidence.push(`${target.id}:install-lifecycle`);
    if (!physical.some((entry) => entry.target === target.id && entry.overallStatus === "passed")) missingEvidence.push(`${target.id}:physical-acceptance`);
  }
  if (!bridge.releaseReady) missingEvidence.push("bridge:six-target-release");
  if (!lifecycle.every((entry) => entry.defaultDiscovery && entry.packagedHelper && entry.adapter.install && entry.adapter.upgrade && entry.adapter.uninstall)) missingEvidence.push("packaged-e2e:adapter-or-discovery");

  const rc6GatePassed = packages.length === brainPetReleaseTargets.length
    && lifecycle.length === lifecycleRequirements.length
    && lifecycle.every((entry) => entry.overallStatus === "passed" && entry.trustedCi)
    && bridge.releaseReady;
  const publicReleaseReady = releaseMode === "public-release" && rc6GatePassed && missingEvidence.length === 0;
  const receiptCore = {
    schemaVersion: 1,
    product: "brainpet",
    appId: brainPetDistributionContract.identity.appId,
    appVersion,
    releaseMode,
    sourceCommit,
    packages,
    lifecycle,
    bridge,
    physical,
    rc6GatePassed,
    missingEvidence,
    publicReleaseReady,
  };
  const receipt = {
    ...receiptCore,
    evidenceDigest: createHash("sha256").update(JSON.stringify(receiptCore)).digest("hex"),
    generatedAt: new Date().toISOString(),
  };
  const outputPath = resolve(options.outputPath);
  assertUnderRoot(outputPath, resolve(options.receiptRoot ?? dirname(outputPath)), "aggregate receipt");
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if (options.expectPublicReady) assert.equal(receipt.publicReleaseReady, true, `Public release evidence is incomplete: ${receipt.missingEvidence.join(", ")}`);
  return receipt;
}

function validatePackageReceipt(paths, packagesRoot, target, releaseMode) {
  const candidates = paths.filter((path) => basename(path) === `brainpet-package-receipt-${target.id}.json`);
  assert.equal(candidates.length, 1, `Expected exactly one package receipt for ${target.id}.`);
  const path = candidates[0];
  const receipt = readJson(path);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.product, "brainpet");
  assert.equal(receipt.appId, brainPetDistributionContract.identity.appId);
  assert.equal(receipt.target, target.id);
  assert.equal(receipt.supportLevel, target.supportLevel);
  assert.equal(receipt.releaseMode, releaseMode);
  assert.equal(receipt.packageTarget, "installer");
  assert.equal(receipt.publicReleaseReady, false, "A target package receipt must never claim aggregate public readiness.");
  assert.equal(receipt.nativeBridgeHelpersBundled, true);
  assert.equal(receipt.bridgeMarketplaceBundled, true);
  assert.match(receipt.appVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `Package receipt ${target.id} has an invalid app version.`);
  assert.equal(typeof receipt.runtimeReleaseReady, "boolean", `Package receipt ${target.id} lacks a runtime trust result.`);
  if (releaseMode === "public-release") assert.equal(receipt.runtimeReleaseReady, true, `Public package ${target.id} did not pass its platform trust gate.`);
  assert.ok(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0);
  const receiptRoot = dirname(path);
  const requiredKinds = target.platform === "windows" ? ["nsis"] : target.platform === "macos" ? ["dmg"] : ["appimage", "deb"];
  assert.deepEqual(receipt.artifacts.map((artifact) => artifact.kind).sort(), requiredKinds.sort(), `Package receipt ${target.id} has an invalid installer artifact set.`);
  for (const artifact of receipt.artifacts) validateArtifactRecord(receiptRoot, artifact, target);
  const executablePath = resolveSafeRelative(receiptRoot, receipt.executable);
  assert.equal(sha256(executablePath), receipt.sha256, `Runtime executable hash mismatch for ${target.id}.`);
  assertBrainPetBinary(readFileSync(executablePath), target, `Aggregate runtime ${target.id}`);
  assert.ok(isRecord(receipt.source) && /^[a-f0-9]{40}$/i.test(receipt.source.commit), `Package receipt ${target.id} lacks an exact source commit.`);
  if (releaseMode === "public-release") validateGitHubProvenance(receiptRoot, receipt, target);
  assertUnderRoot(path, packagesRoot, "package receipt");
  return receipt;
}

function validateGitHubProvenance(receiptRoot, receipt, target) {
  assert.equal(receipt.source.githubActions, true, `Public package ${target.id} must come from GitHub Actions.`);
  assert.equal(receipt.source.repository, brainPetDistributionContract.identity.repository);
  assert.equal(receipt.source.runnerEnvironment, "github-hosted", `Public package ${target.id} must come from a GitHub-hosted runner.`);
  const bundle = join(receiptRoot, "brainpet-github-attestations.jsonl");
  assert.ok(existsSync(bundle), `Public package ${target.id} is missing its GitHub provenance bundle.`);
  const repository = brainPetDistributionContract.identity.repository;
  const signerWorkflow = `github.com/${repository}/.github/workflows/brainpet-public-release-gate.yml`;
  for (const artifact of receipt.artifacts) {
    const path = resolveSafeRelative(receiptRoot, artifact.path);
    const verification = spawnSync("gh", ["attestation", "verify", path, "--bundle", bundle, "--repo", repository, "--signer-workflow", signerWorkflow, "--source-digest", receipt.source.commit, "--deny-self-hosted-runners", "--format", "json"], { encoding: "utf8" });
    assert.equal(verification.status, 0, verification.stderr || `GitHub provenance failed for ${target.id}/${artifact.kind}.`);
    const result = JSON.parse(verification.stdout);
    assert.ok(Array.isArray(result) && result.length > 0, `GitHub provenance returned no verified statement for ${target.id}/${artifact.kind}.`);
  }
}

function validateLifecycleReceipt(paths, requirement, packages, releaseMode) {
  const expectedName = `brainpet-install-lifecycle-receipt-${requirement.target}-${requirement.kind}.json`;
  const candidates = paths.filter((path) => basename(path) === expectedName);
  assert.equal(candidates.length, 1, `Expected exactly one lifecycle receipt for ${requirement.target}/${requirement.kind}.`);
  const receipt = readJson(candidates[0]);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.product, "brainpet");
  assert.equal(receipt.target, requirement.target);
  assert.equal(receipt.artifactKind, requirement.kind);
  assert.equal(receipt.realInstaller, true);
  assert.equal(receipt.defaultInstallPath, true);
  assert.equal(receipt.defaultDiscovery, true);
  assert.equal(receipt.packagedHelper, true);
  assert.equal(receipt.toolchainIsolatedHelper, true);
  assert.equal(receipt.cleanRunner, true);
  assert.equal(receipt.install.passed, true);
  assert.equal(receipt.start.passed, true);
  assert.equal(receipt.upgrade.passed, true);
  assert.equal(receipt.upgrade.statePreserved, true);
  assert.equal(receipt.coldWake.passed, true);
  assert.equal(receipt.uninstall.passed, true);
  assert.equal(receipt.uninstall.helperFailOpen, true);
  assert.equal(receipt.adapter.install, true);
  assert.equal(receipt.adapter.upgrade, true);
  assert.equal(receipt.adapter.uninstall, true);
  assert.equal(receipt.overallStatus, "passed");
  assert.equal(receipt.trustedCi, true);
  assert.equal(receipt.source.repository, brainPetDistributionContract.identity.repository);
  assert.match(receipt.source.commit, /^[a-f0-9]{40}$/i);
  const packageReceipt = packages.find((entry) => entry.target === requirement.target);
  assert.ok(packageReceipt, `Lifecycle target has no package receipt: ${requirement.target}`);
  const artifact = packageReceipt.artifacts.find((entry) => entry.kind === requirement.kind);
  assert.ok(artifact, `Lifecycle target has no ${requirement.kind} package artifact.`);
  assert.equal(receipt.currentArtifact.version, packageReceipt.appVersion, `Lifecycle version mismatch for ${requirement.target}/${requirement.kind}.`);
  assert.equal(receipt.currentArtifact.sha256, artifact.sha256, `Lifecycle artifact hash mismatch for ${requirement.target}/${requirement.kind}.`);
  if (releaseMode === "public-release") validateLifecycleProvenance(candidates[0], receipt);
  return receipt;
}

function validateLifecycleProvenance(receiptPath, receipt) {
  assert.equal(receipt.source.workflow, "BrainPet public release gate");
  const bundle = join(dirname(receiptPath), "brainpet-github-attestations.jsonl");
  assert.ok(existsSync(bundle), `Public lifecycle ${receipt.target}/${receipt.artifactKind} is missing its GitHub provenance bundle.`);
  const repository = brainPetDistributionContract.identity.repository;
  const signerWorkflow = `github.com/${repository}/.github/workflows/brainpet-public-release-gate.yml`;
  const verification = spawnSync("gh", ["attestation", "verify", receiptPath, "--bundle", bundle, "--repo", repository, "--signer-workflow", signerWorkflow, "--source-digest", receipt.source.commit, "--deny-self-hosted-runners", "--format", "json"], { encoding: "utf8" });
  assert.equal(verification.status, 0, verification.stderr || `GitHub provenance failed for lifecycle ${receipt.target}/${receipt.artifactKind}.`);
  const result = JSON.parse(verification.stdout);
  assert.ok(Array.isArray(result) && result.length > 0, `GitHub provenance returned no lifecycle statement for ${receipt.target}/${receipt.artifactKind}.`);
}

function validateBridgeReceipt(bridgeRoot) {
  const receipt = readJson(join(bridgeRoot, "brainpet-release.json"));
  assert.equal(receipt.product, "brainpet");
  assert.equal(receipt.bridgeVersion, brainPetDistributionContract.bridge.version);
  assert.equal(receipt.files.length, brainPetReleaseTargets.length);
  for (const target of brainPetReleaseTargets) {
    const record = receipt.files.find((entry) => entry.target === target.id);
    assert.ok(record, `Bridge receipt is missing ${target.id}.`);
    const helper = join(bridgeRoot, "bin", target.id, target.helperName);
    assert.equal(sha256(helper), record.sha256, `Bridge helper receipt mismatch for ${target.id}.`);
    assertBrainPetBinary(readFileSync(helper), target, `Aggregate Bridge helper ${target.id}`);
  }
  assert.ok(isRecord(receipt.source) && /^[a-f0-9]{40}$/i.test(receipt.source.commit), "Bridge receipt lacks an exact source commit.");
  return { bridgeVersion: receipt.bridgeVersion, targetCount: receipt.files.length, sha256: sha256(join(bridgeRoot, "brainpet-release.json")), source: receipt.source, releaseReady: true };
}

function validateBridgeProvenance(bridgeRoot, bridge) {
  assert.equal(bridge.source.githubActions, true, "Public Bridge must come from GitHub Actions.");
  assert.equal(bridge.source.repository, brainPetDistributionContract.identity.repository);
  assert.equal(bridge.source.runnerEnvironment, "github-hosted", "Public Bridge must come from a GitHub-hosted runner.");
  const receiptPath = join(bridgeRoot, "brainpet-release.json");
  const bundle = join(bridgeRoot, "brainpet-github-attestations.jsonl");
  assert.ok(existsSync(bundle), "Public Bridge is missing its GitHub provenance bundle.");
  const repository = brainPetDistributionContract.identity.repository;
  const signerWorkflow = `github.com/${repository}/.github/workflows/brainpet-public-release-gate.yml`;
  const verification = spawnSync("gh", ["attestation", "verify", receiptPath, "--bundle", bundle, "--repo", repository, "--signer-workflow", signerWorkflow, "--source-digest", bridge.source.commit, "--deny-self-hosted-runners", "--format", "json"], { encoding: "utf8" });
  assert.equal(verification.status, 0, verification.stderr || "GitHub provenance failed for the BrainPet Bridge receipt.");
  const result = JSON.parse(verification.stdout);
  assert.ok(Array.isArray(result) && result.length > 0, "GitHub provenance returned no verified Bridge statement.");
}

function validatePhysicalReceipt(path) {
  const receipt = readJson(path);
  assert.equal(receipt.schemaVersion, 2, "RC6 physical receipts must use schema v2.");
  assert.ok(brainPetReleaseTargets.some((target) => target.id === receipt.target), "Physical receipt target is invalid.");
  assert.ok(["passed", "incomplete"].includes(receipt.overallStatus));
  assert.ok(typeof receipt.artifactSha256 === "string" && /^[a-f0-9]{64}$/i.test(receipt.artifactSha256));
  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/i, "Physical receipt must bind the exact release commit.");
  return { target: receipt.target, overallStatus: receipt.overallStatus, artifactSha256: receipt.artifactSha256, receiptSha256: sha256(path), sourceCommit: receipt.sourceCommit, recordedAt: receipt.completedAt };
}

function validateArtifactRecord(receiptRoot, artifact, target) {
  assert.ok(isRecord(artifact) && typeof artifact.path === "string" && typeof artifact.kind === "string");
  const path = resolveSafeRelative(receiptRoot, artifact.path);
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Release artifact must be a regular file: ${artifact.path}`);
  assert.equal(stat.size, artifact.bytes, `Release artifact size mismatch: ${artifact.path}`);
  assert.equal(sha256(path), artifact.sha256, `Release artifact hash mismatch: ${artifact.path}`);
  assert.ok(stat.size >= 16 * 1024, `Release artifact is implausibly small: ${artifact.path}`);
  const bytes = readFileSync(path);
  if (artifact.kind === "nsis" || artifact.kind === "portable") assert.equal(inspectExecutableBinary(bytes).format, "pe", `${artifact.kind} must be a PE executable.`);
  else if (artifact.kind === "dmg") assert.equal(bytes.toString("ascii", bytes.length - 512, bytes.length - 508), "koly", "DMG must contain a UDIF trailer.");
  else if (artifact.kind === "appimage") assert.equal(inspectExecutableBinary(bytes).format, "elf", "AppImage must be an ELF executable.");
  else if (artifact.kind === "deb") assert.equal(bytes.toString("ascii", 0, 8), "!<arch>\n", "deb must be an ar archive.");
  else assert.fail(`Unsupported release artifact kind for ${target.id}: ${artifact.kind}`);
}

function findFiles(directory, pattern) {
  assert.ok(existsSync(directory) && lstatSync(directory).isDirectory(), `Evidence directory is missing: ${directory}`);
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && pattern.test(entry.name)) files.push(path);
    }
  };
  visit(directory);
  return files;
}

function readJson(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, `Unsafe or oversized receipt: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveSafeRelative(rootDirectory, value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 4096, "Evidence path is invalid.");
  const path = resolve(rootDirectory, value);
  assertUnderRoot(path, rootDirectory, "evidence artifact");
  return path;
}

function assertUnderRoot(path, expectedRoot, label) {
  const child = relative(resolve(expectedRoot), resolve(path));
  assert.ok(child && !child.startsWith("..") && !child.includes(`..${process.platform === "win32" ? "\\" : "/"}`), `${label} must stay under its evidence root.`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--packages") options.packagesRoot = argv[++index];
    else if (arg === "--lifecycle") options.lifecycleRoot = argv[++index];
    else if (arg === "--bridge") options.bridgeRoot = argv[++index];
    else if (arg === "--physical") options.physicalRoot = argv[++index];
    else if (arg === "--output") options.outputPath = argv[++index];
    else if (arg === "--mode") options.releaseMode = argv[++index];
    else if (arg === "--expect-public-ready") options.expectPublicReady = true;
    else throw new Error(`Unknown aggregate receipt argument: ${arg}`);
  }
  if (!options.packagesRoot || !options.lifecycleRoot || !options.bridgeRoot || !options.outputPath) throw new Error("Usage: aggregate-brainpet-release-receipt.mjs --packages <dir> --lifecycle <dir> --bridge <dir> --output <receipt.json> [--physical <dir>] [--mode private-test|public-release]");
  options.receiptRoot = dirname(resolve(options.outputPath));
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = aggregateBrainPetReleaseReceipt(parseArgs(process.argv.slice(2)));
    console.log(`BrainPet aggregate receipt created (rc6GatePassed=${receipt.rc6GatePassed}, publicReleaseReady=${receipt.publicReleaseReady}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
