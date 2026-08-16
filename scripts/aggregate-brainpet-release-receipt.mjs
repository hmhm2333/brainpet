#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract, brainPetReleaseTargets } from "./brainpet-release-contract.mjs";
import { assertBrainPetBinary, inspectExecutableBinary } from "./brainpet-binary-format.mjs";
import { validateBrainPetPhysicalReceipt, validateBrainPetPhysicalReceiptSet } from "./brainpet-physical-receipt-contract.mjs";
import { brainPetPhysicalReceiptWorkflow, brainPetPublicReleaseWorkflow, brainPetSigstoreBundlePath, verifyBrainPetSigstoreSubject } from "./brainpet-sigstore-provenance.mjs";
import { validateBrainPetPackageArtifactClosure } from "./stage-brainpet-package-artifacts.mjs";

const lifecycleRequirements = Object.freeze([
  { target: "windows-x64", kind: "nsis" },
  { target: "macos-arm64", kind: "dmg" },
  { target: "linux-x64", kind: "appimage" },
  { target: "linux-x64", kind: "deb" },
]);

export function aggregateBrainPetReleaseReceipt(options) {
  const releaseMode = options.releaseMode ?? "private-test";
  const provenanceVerifier = options.provenanceVerifier ?? verifyBrainPetSigstoreSubject;
  assert.ok(["private-test", "public-release"].includes(releaseMode), "Invalid aggregate release mode.");
  const packagesRoot = resolve(options.packagesRoot);
  const lifecycleRoot = resolve(options.lifecycleRoot);
  const bridgeRoot = resolve(options.bridgeRoot);
  const provenanceRoot = releaseMode === "public-release" ? resolve(options.provenanceRoot ?? "") : null;
  if (releaseMode === "public-release") {
    const provenanceStat = options.provenanceRoot && existsSync(provenanceRoot) ? lstatSync(provenanceRoot) : null;
    assert.ok(provenanceStat?.isDirectory() && !provenanceStat.isSymbolicLink(), "Public release requires a regular Sigstore provenance bundle directory.");
  }
  const packageReceipts = findFiles(packagesRoot, /^brainpet-package-receipt-[a-z0-9-]+\.json$/);
  const lifecycleReceipts = findFiles(lifecycleRoot, /^brainpet-install-lifecycle-receipt-[a-z0-9-]+-[a-z0-9-]+\.json$/);
  const physicalReceipts = options.physicalRoot && existsSync(resolve(options.physicalRoot))
    ? findFiles(resolve(options.physicalRoot), /^brainpet-physical-receipt\.json$/)
    : [];

  const packages = brainPetReleaseTargets.map((target) => validatePackageReceipt(packageReceipts, packagesRoot, target, releaseMode, provenanceRoot, provenanceVerifier));
  const appVersions = new Set(packages.map((entry) => entry.appVersion));
  assert.equal(appVersions.size, 1, "All runtime packages must use one exact app version.");
  const appVersion = [...appVersions][0];
  const lifecycle = lifecycleRequirements.map((requirement) => validateLifecycleReceipt(lifecycleReceipts, requirement, packages, releaseMode, provenanceRoot, provenanceVerifier));
  const bridge = validateBridgeReceipt(bridgeRoot);
  if (releaseMode === "public-release") validateBridgeProvenance(bridgeRoot, bridge, provenanceRoot, provenanceVerifier);
  const physicalEvidence = physicalReceipts.map((path) => validatePhysicalReceipt(path));
  if (releaseMode === "public-release" && physicalEvidence.length > 0) validateBrainPetPhysicalReceiptSet(physicalEvidence.map((entry) => entry.receipt));
  const physical = physicalEvidence.map(({ receipt: _receipt, path: _path, ...summary }) => summary);
  const sourceCommits = new Set(packages.map((entry) => entry.source.commit));
  for (const entry of lifecycle) sourceCommits.add(entry.source.commit);
  sourceCommits.add(bridge.source.commit);
  assert.equal(sourceCommits.size, 1, "Release evidence must bind one exact source commit.");
  const sourceCommit = [...sourceCommits][0];
  let sourceRunId = null;
  let sourceRunAttempt = null;
  if (releaseMode === "public-release") {
    const sourceRunIds = new Set([...packages, ...lifecycle, bridge].map((entry) => entry.source.runId));
    const sourceRunAttempts = new Set([...packages, ...lifecycle, bridge].map((entry) => entry.source.runAttempt));
    assert.equal(sourceRunIds.size, 1, "Public release evidence must come from one exact workflow run.");
    assert.equal(sourceRunAttempts.size, 1, "Public release evidence must come from one exact workflow attempt.");
    [sourceRunId] = sourceRunIds;
    [sourceRunAttempt] = sourceRunAttempts;
  }
  if (releaseMode === "public-release" && physicalEvidence.length > 0) {
    assert.ok(options.physicalProvenanceRoot, "Public physical evidence requires --physical-provenance.");
    validatePhysicalEvidenceProvenance({
      physicalEvidence,
      physicalRoot: resolve(options.physicalRoot),
      provenanceRoot: resolve(options.physicalProvenanceRoot ?? ""),
      provenanceVerifier,
      sourceCommit,
      sourceRunId,
    });
  }
  const physicalChallenges = new Set(physical.map((entry) => entry.candidate.challenge));
  const physicalChallenge = releaseMode !== "public-release"
    ? null
    : physicalChallenges.size === 0
      ? randomBytes(32).toString("hex")
      : physicalChallenges.size === 1
        ? [...physicalChallenges][0]
        : assert.fail("Physical receipts must bind one public-candidate challenge.");
  for (const entry of physical) {
    assert.equal(entry.sourceCommit, sourceCommit, `Physical receipt ${entry.target} is not bound to release commit ${sourceCommit}.`);
    const packageReceipt = packages.find((candidate) => candidate.target === entry.target);
    assert.ok(packageReceipt?.artifacts.some((artifact) => artifact.sha256 === entry.artifactSha256), `Physical receipt ${entry.target} does not reference an aggregated installer artifact.`);
    assert.equal(String(entry.candidate.runId), String(sourceRunId), `Physical receipt ${entry.target} references a different candidate run.`);
  }

  const missingEvidence = [];
  const stableTargets = brainPetReleaseTargets.filter((target) => target.supportLevel === "stable");
  for (const target of stableTargets) {
    const packageReceipt = packages.find((entry) => entry.target === target.id);
    if (!packageReceipt?.runtimeReleaseReady) missingEvidence.push(`${target.id}:direct-runtime-package`);
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
    schemaVersion: 2,
    product: "brainpet",
    appId: brainPetDistributionContract.identity.appId,
    appVersion,
    releaseMode,
    releasePolicy: brainPetDistributionContract.releasePolicy,
    operatingSystemPublisherTrust: false,
    manualUserConsentRequired: releaseMode === "public-release",
    sourceCommit,
    sourceRunId,
    sourceRunAttempt,
    physicalChallenge,
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

function validatePackageReceipt(paths, packagesRoot, target, releaseMode, provenanceRoot, provenanceVerifier) {
  const candidates = paths.filter((path) => basename(path) === `brainpet-package-receipt-${target.id}.json`);
  assert.equal(candidates.length, 1, `Expected exactly one package receipt for ${target.id}.`);
  const path = candidates[0];
  const receipt = readJson(path);
  assert.equal(receipt.schemaVersion, 2);
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
  assert.ok(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0);
  const receiptRoot = dirname(path);
  if (releaseMode === "public-release") validateBrainPetPackageArtifactClosure(receiptRoot, target.id);
  const requiredKinds = target.platform === "windows" ? ["nsis"] : target.platform === "macos" ? ["dmg"] : ["appimage", "deb"];
  assert.deepEqual(receipt.artifacts.map((artifact) => artifact.kind).sort(), requiredKinds.sort(), `Package receipt ${target.id} has an invalid installer artifact set.`);
  for (const artifact of receipt.artifacts) validateArtifactRecord(receiptRoot, artifact, target);
  if (releaseMode !== "public-release") {
    const executablePath = resolveSafeRelative(receiptRoot, receipt.executable);
    assert.equal(sha256(executablePath), receipt.sha256, `Runtime executable hash mismatch for ${target.id}.`);
    assertBrainPetBinary(readFileSync(executablePath), target, `Aggregate runtime ${target.id}`);
  }
  assert.ok(isRecord(receipt.source) && /^[a-f0-9]{40}$/i.test(receipt.source.commit), `Package receipt ${target.id} lacks an exact source commit.`);
  if (releaseMode === "public-release") {
    assert.equal(receipt.source.workflow, brainPetPublicReleaseWorkflow.name, `Public package ${target.id} came from the wrong workflow.`);
    assert.match(receipt.source.runId ?? "", /^\d{1,20}$/, `Public package ${target.id} lacks a workflow run id.`);
    assert.match(receipt.source.runAttempt ?? "", /^\d{1,10}$/, `Public package ${target.id} lacks a workflow run attempt.`);
    assert.equal(receipt.source.treeDirty, false, `Public package ${target.id} came from a dirty tracked tree.`);
    assert.equal(receipt.installerValidated, true, `Public package ${target.id} did not pass its installer structure gate.`);
    assert.equal(receipt.signatureValidated, false, `Public package ${target.id} must not claim a platform publisher signature.`);
    assert.equal(receipt.unsignedPolicyValidated, true, `Public package ${target.id} did not prove signature absence according to policy.`);
    assert.equal(receipt.platformSignatureStatus, "absent-by-policy", `Public package ${target.id} has the wrong platform signature policy.`);
    assert.equal(receipt.distributionChannel, "direct-download", `Public package ${target.id} has the wrong distribution channel.`);
    assert.equal(receipt.userConsentRequired, true, `Public package ${target.id} must require explicit user consent.`);
    assert.equal(receipt.publisherRegistrationRequired, false, `Public package ${target.id} must not require publisher registration.`);
    assert.equal(receipt.provenanceValidated, false, `Package-stage receipt ${target.id} must defer Sigstore validation to aggregation.`);
    assert.equal(receipt.runtimeReleaseReady, true, `Public package ${target.id} did not pass its unsigned direct-release gate.`);
    validateSigstoreProvenance(receiptRoot, receipt, target, provenanceRoot, provenanceVerifier);
  }
  assertUnderRoot(path, packagesRoot, "package receipt");
  return releaseMode === "public-release" ? { ...receipt, provenanceValidated: true } : receipt;
}

function validateSigstoreProvenance(receiptRoot, receipt, target, provenanceRoot, provenanceVerifier) {
  assert.equal(receipt.source.githubActions, true, `Public package ${target.id} must come from GitHub Actions.`);
  assert.equal(receipt.source.repository, brainPetDistributionContract.identity.repository);
  assert.equal(receipt.source.runnerEnvironment, "github-hosted", `Public package ${target.id} must come from a GitHub-hosted runner.`);
  const repository = brainPetDistributionContract.identity.repository;
  const receiptPath = join(receiptRoot, `brainpet-package-receipt-${target.id}.json`);
  provenanceVerifier(createProvenanceEvidence(receiptPath, provenanceRoot, repository, receipt.source.commit, `${target.id}/package-receipt`));
  for (const artifact of receipt.artifacts) {
    const path = resolveSafeRelative(receiptRoot, artifact.path);
    provenanceVerifier(createProvenanceEvidence(path, provenanceRoot, repository, receipt.source.commit, `${target.id}/${artifact.kind}`));
  }
}

function validateLifecycleReceipt(paths, requirement, packages, releaseMode, provenanceRoot, provenanceVerifier) {
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
  if (releaseMode === "public-release") validateLifecycleProvenance(candidates[0], receipt, provenanceRoot, provenanceVerifier);
  return receipt;
}

function validateLifecycleProvenance(receiptPath, receipt, provenanceRoot, provenanceVerifier) {
  assert.equal(receipt.source.workflow, brainPetPublicReleaseWorkflow.name);
  assert.match(receipt.source.runId ?? "", /^\d{1,20}$/, `Public lifecycle ${receipt.target}/${receipt.artifactKind} lacks a workflow run id.`);
  assert.match(receipt.source.runAttempt ?? "", /^\d{1,10}$/, `Public lifecycle ${receipt.target}/${receipt.artifactKind} lacks a workflow run attempt.`);
  const repository = brainPetDistributionContract.identity.repository;
  provenanceVerifier(createProvenanceEvidence(receiptPath, provenanceRoot, repository, receipt.source.commit, `lifecycle ${receipt.target}/${receipt.artifactKind}`));
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

function validateBridgeProvenance(bridgeRoot, bridge, provenanceRoot, provenanceVerifier) {
  assert.equal(bridge.source.githubActions, true, "Public Bridge must come from GitHub Actions.");
  assert.equal(bridge.source.repository, brainPetDistributionContract.identity.repository);
  assert.equal(bridge.source.runnerEnvironment, "github-hosted", "Public Bridge must come from a GitHub-hosted runner.");
  assert.equal(bridge.source.workflow, brainPetPublicReleaseWorkflow.name, "Public Bridge came from the wrong workflow.");
  assert.match(bridge.source.runId ?? "", /^\d{1,20}$/, "Public Bridge lacks a workflow run id.");
  assert.match(bridge.source.runAttempt ?? "", /^\d{1,10}$/, "Public Bridge lacks a workflow run attempt.");
  const receiptPath = join(bridgeRoot, "brainpet-release.json");
  const repository = brainPetDistributionContract.identity.repository;
  provenanceVerifier(createProvenanceEvidence(receiptPath, provenanceRoot, repository, bridge.source.commit, "BrainPet Bridge receipt"));
}

function createProvenanceEvidence(subjectPath, provenanceRoot, repository, sourceCommit, label, workflow = brainPetPublicReleaseWorkflow) {
  const digest = sha256(subjectPath);
  return {
    subjectPath,
    bundlesRoot: provenanceRoot,
    bundlePath: brainPetSigstoreBundlePath(provenanceRoot, digest),
    repository,
    workflowPath: workflow.path,
    workflowName: workflow.name,
    sourceCommit,
    label,
  };
}

function validatePhysicalReceipt(path) {
  const receipt = readJson(path);
  const normalized = validateBrainPetPhysicalReceipt(receipt);
  return { path, target: normalized.target, overallStatus: normalized.overallStatus, artifactSha256: normalized.artifactSha256, receiptSha256: sha256(path), sourceCommit: normalized.sourceCommit, candidate: normalized.candidate, reviewer: normalized.reviewer, recordedAt: normalized.completedAt, receipt: normalized };
}

function validatePhysicalEvidenceProvenance({ physicalEvidence, physicalRoot, provenanceRoot, provenanceVerifier, sourceCommit, sourceRunId }) {
  const provenanceStat = existsSync(provenanceRoot) ? lstatSync(provenanceRoot) : null;
  assert.ok(provenanceStat?.isDirectory() && !provenanceStat.isSymbolicLink(), "Public physical evidence requires a regular Sigstore provenance directory.");
  const intakePath = join(physicalRoot, "brainpet-physical-intake.json");
  const intake = readJson(intakePath);
  assert.equal(intake.schemaVersion, 2, "Physical intake schema is invalid.");
  assert.equal(intake.product, "brainpet");
  assert.equal(intake.repository, brainPetDistributionContract.identity.repository);
  assert.equal(intake.sourceCommit, sourceCommit);
  assert.equal(String(intake.candidate?.runId), String(sourceRunId), "Physical intake references a different candidate run.");
  assert.match(intake.candidate?.receiptSha256 ?? "", /^[a-f0-9]{64}$/i, "Physical intake candidate receipt digest is invalid.");
  assert.match(intake.candidate?.challenge ?? "", /^[a-f0-9]{64}$/i, "Physical intake candidate challenge is invalid.");
  assert.equal(intake.github?.workflow, brainPetPhysicalReceiptWorkflow.name);
  assert.equal(intake.github?.runnerEnvironment, "github-hosted");
  assert.ok(typeof intake.github?.actor === "string" && intake.github.actor.length > 0, "Physical intake lacks an authenticated workflow dispatcher.");
  assert.equal(intake.github?.environment, "brainpet-physical-acceptance");
  assert.ok(typeof intake.github?.environmentReviewer === "string" && intake.github.environmentReviewer.length > 0, "Physical intake lacks an authenticated environment reviewer.");
  assert.notEqual(intake.github.environmentReviewer.toLowerCase(), intake.github.actor.toLowerCase(), "Physical intake environment approval was a self-review.");
  const normalizedReceipts = validateBrainPetPhysicalReceiptSet(physicalEvidence.map((entry) => entry.receipt), {
    expectedSourceCommit: sourceCommit,
    expectedCandidate: intake.candidate,
    expectedReviewer: intake.github.environmentReviewer,
  });
  for (let index = 0; index < normalizedReceipts.length; index += 1) {
    const receipt = normalizedReceipts[index];
    const entry = physicalEvidence[index];
    const intakeTarget = intake.targets.find((target) => target.target === receipt.target);
    assert.equal(intakeTarget?.artifactSha256, receipt.artifactSha256, `Physical intake artifact hash mismatch for ${receipt.target}.`);
    assert.equal(intakeTarget?.completedAt, receipt.completedAt, `Physical intake completion time mismatch for ${receipt.target}.`);
    provenanceVerifier(createProvenanceEvidence(entry.path, provenanceRoot, brainPetDistributionContract.identity.repository, sourceCommit, `physical ${receipt.target}`, brainPetPhysicalReceiptWorkflow));
  }
  provenanceVerifier(createProvenanceEvidence(intakePath, provenanceRoot, brainPetDistributionContract.identity.repository, sourceCommit, "physical intake", brainPetPhysicalReceiptWorkflow));
  const expectedBundles = [...physicalEvidence.map((entry) => entry.path), intakePath].map((path) => basename(brainPetSigstoreBundlePath(provenanceRoot, sha256(path)))).sort();
  const actualBundles = readdirSync(provenanceRoot, { withFileTypes: true }).map((entry) => {
    assert.ok(entry.isFile() && !entry.isSymbolicLink(), `Physical provenance contains an unexpected entry: ${entry.name}`);
    return entry.name;
  }).sort();
  assert.deepEqual(actualBundles, expectedBundles, "Physical provenance bundle closure is incomplete or contains an extra file.");
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
    else if (arg === "--physical-provenance") options.physicalProvenanceRoot = argv[++index];
    else if (arg === "--provenance") options.provenanceRoot = argv[++index];
    else if (arg === "--output") options.outputPath = argv[++index];
    else if (arg === "--mode") options.releaseMode = argv[++index];
    else if (arg === "--expect-public-ready") options.expectPublicReady = true;
    else throw new Error(`Unknown aggregate receipt argument: ${arg}`);
  }
  if (!options.packagesRoot || !options.lifecycleRoot || !options.bridgeRoot || !options.outputPath) throw new Error("Usage: aggregate-brainpet-release-receipt.mjs --packages <dir> --lifecycle <dir> --bridge <dir> --output <receipt.json> [--physical <dir> --physical-provenance <bundle-dir>] [--provenance <bundle-dir>] [--mode private-test|public-release]");
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
