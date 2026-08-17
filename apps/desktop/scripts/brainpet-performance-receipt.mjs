#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract, brainPetReleaseTargets } from "../../../scripts/brainpet-release-contract.mjs";
import { assertBrainPetPerformanceWallClock } from "../../../scripts/brainpet-performance-metrics-contract.mjs";
import { brainPetPublicReleaseWorkflow, verifyBrainPetSigstoreSubject } from "../../../scripts/brainpet-sigstore-provenance.mjs";
import { validateBrainPetPackageArtifactClosure } from "../../../scripts/stage-brainpet-package-artifacts.mjs";
import { brainPetFormalPerformanceContract, normalizeBrainPetFormalGateResult, validateBrainPetFormalGateResult } from "./brainpet-performance-contract.mjs";
import { validateBrainPetRuntimeTree, validateBrainPetRuntimeTreeShape } from "./brainpet-runtime-tree.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const defaultRepoRoot = resolve(appDir, "..", "..");
const formalGateProfiles = new Set(["active-30m", "idle-24h"]);
const preparedManifestName = "brainpet-performance-candidate.json";
const publicCandidateMissingEvidence = Object.freeze([
  "macos-arm64:physical-acceptance",
  "performance:active-30m",
  "performance:idle-24h",
  "windows-x64:physical-acceptance",
]);

export class BrainPetPerformanceReceiptRollbackError extends AggregateError {
  constructor(errors, receiptPath) {
    super(errors, "BrainPet performance receipt validation failed and its published bytes could not be rolled back.");
    this.name = "BrainPetPerformanceReceiptRollbackError";
    this.receiptPath = resolve(receiptPath);
  }
}

export function resolveTrackedGitIdentity(repoRoot = defaultRepoRoot) {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  assert.equal(commit.status, 0, commit.stderr || "Unable to resolve the BrainPet source commit.");
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  assert.equal(status.status, 0, status.stderr || "Unable to inspect the BrainPet tracked worktree.");
  const sourceCommit = commit.stdout.trim();
  assert.match(sourceCommit, /^[a-f0-9]{40}$/i, "BrainPet performance evidence requires an exact Git commit.");
  return {
    repository: brainPetDistributionContract.identity.repository,
    commit: sourceCommit,
    treeDirty: status.stdout.trim().length > 0,
  };
}

export function createBrainPetPreparedPerformanceManifest(core) {
  assertPreparedPerformanceManifestCore(core);
  return Object.freeze({ ...core, evidenceDigest: sha256Bytes(Buffer.from(JSON.stringify(core))) });
}

export function readBrainPetPreparedPerformanceManifest(manifestPath, { repoRoot = defaultRepoRoot } = {}) {
  const resolvedRepoRoot = realpathSync.native(resolve(repoRoot));
  const requestedManifestPath = resolve(manifestPath);
  assertRegularFile(requestedManifestPath, "BrainPet prepared performance manifest", 2 * 1024 * 1024);
  const resolvedManifestPath = realpathSync.native(requestedManifestPath);
  assertUnderRoot(resolvedManifestPath, resolvedRepoRoot, "BrainPet prepared performance manifest");
  assert.equal(basename(resolvedManifestPath), preparedManifestName, `Prepared performance manifest must be named ${preparedManifestName}.`);
  const manifest = JSON.parse(readFileSync(resolvedManifestPath, "utf8"));
  const { evidenceDigest, ...core } = manifest;
  assertPreparedPerformanceManifestCore(core);
  assert.equal(evidenceDigest, sha256Bytes(Buffer.from(JSON.stringify(core))), "BrainPet prepared performance manifest digest is invalid.");
  const candidateRoot = dirname(resolvedManifestPath);
  const paths = Object.freeze({
    manifest: resolvedManifestPath,
    candidateReceipt: resolveSafeRelative(candidateRoot, manifest.candidateReceipt, "prepared public-candidate receipt"),
    packageReceipt: resolveSafeRelative(candidateRoot, manifest.packageReceipt, "prepared package receipt"),
    installer: resolveSafeRelative(candidateRoot, manifest.installer, "prepared installer"),
    runtimeRoot: resolveSafeRelative(candidateRoot, manifest.runtimeRoot, "prepared runtime root"),
    executable: resolveSafeRelative(candidateRoot, manifest.executable, "prepared executable"),
    appAsar: resolveSafeRelative(candidateRoot, manifest.appAsar, "prepared app.asar"),
  });
  return Object.freeze({ manifest: Object.freeze(manifest), candidateRoot, paths });
}

export function validateBrainPetPreparedPerformanceCandidate(manifestPath, options = {}) {
  const prepared = readBrainPetPreparedPerformanceManifest(manifestPath, options);
  return validateBrainPetPerformanceCandidate({
    packageReceiptPath: prepared.paths.packageReceipt,
    executablePath: prepared.paths.executable,
    preparedManifestPath: prepared.paths.manifest,
    ...options,
  });
}

export function validateBrainPetPerformanceCandidate({ packageReceiptPath, executablePath, preparedManifestPath, repoRoot = defaultRepoRoot, gitIdentity = resolveTrackedGitIdentity(repoRoot), platform = process.platform, provenanceVerifier = verifyBrainPetSigstoreSubject }) {
  assert.equal(platform, "win32", "Formal BrainPet performance evidence currently requires Windows.");
  assert.ok(typeof packageReceiptPath === "string" && packageReceiptPath.length > 0, "BRAINPET_PACKAGE_RECEIPT is required for a formal performance gate.");
  assert.ok(typeof executablePath === "string" && executablePath.length > 0, "A packaged BrainPet executable is required for a formal performance gate.");
  assert.equal(gitIdentity.repository, brainPetDistributionContract.identity.repository, "Performance candidate repository identity is invalid.");
  assert.match(gitIdentity.commit, /^[a-f0-9]{40}$/i, "Performance candidate source commit is invalid.");
  assert.equal(gitIdentity.treeDirty, false, "Formal BrainPet performance evidence requires a clean tracked worktree.");

  const resolvedRepoRoot = realpathSync(resolve(repoRoot));
  const requestedReceiptPath = resolve(packageReceiptPath);
  assertRegularFile(requestedReceiptPath, "BrainPet package receipt", 2 * 1024 * 1024);
  const resolvedReceiptPath = realpathSync.native(requestedReceiptPath);
  assertUnderRoot(resolvedReceiptPath, resolvedRepoRoot, "BrainPet package receipt");
  const packageReceiptBytes = readFileSync(resolvedReceiptPath);
  const packageReceipt = JSON.parse(packageReceiptBytes.toString("utf8"));
  assert.equal(packageReceipt.schemaVersion, 2, "Formal performance evidence requires a schema-v2 package receipt.");
  assert.equal(packageReceipt.product, "brainpet");
  assert.equal(packageReceipt.appId, brainPetDistributionContract.identity.appId);
  assert.equal(packageReceipt.target, "windows-x64", "Formal local performance evidence must use the Windows x64 package.");
  assert.ok(["private-test", "public-release"].includes(packageReceipt.releaseMode), "Formal performance package mode is invalid.");
  assert.ok(packageReceipt.source && typeof packageReceipt.source === "object", "BrainPet package receipt lacks source identity.");
  assert.equal(packageReceipt.source.repository, gitIdentity.repository, "BrainPet package receipt repository does not match the current checkout.");
  assert.equal(packageReceipt.source.commit, gitIdentity.commit, "BrainPet package receipt commit does not match the current checkout.");
  assert.equal(packageReceipt.source.treeDirty, false, "BrainPet package receipt was built from a dirty tracked worktree.");
  assert.match(packageReceipt.appVersion ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "BrainPet package receipt has an invalid app version.");
  assert.match(packageReceipt.sha256 ?? "", /^[a-f0-9]{64}$/i, "BrainPet package receipt lacks an executable hash.");
  assert.match(packageReceipt.appAsarSha256 ?? "", /^[a-f0-9]{64}$/i, "BrainPet package receipt lacks an app.asar hash.");
  validateBrainPetRuntimeTreeShape(packageReceipt.runtimeTree);

  const expectedExecutable = resolve(executablePath);
  let prepared = null;
  let installer = null;
  let candidateReceipt = null;
  let provenanceSubjects = null;
  let receiptExecutable;
  let appAsar;
  if (packageReceipt.releaseMode === "public-release") {
    assert.equal(packageReceipt.packageTarget, "installer", "Formal public performance evidence must use an installer package.");
    assert.equal(packageReceipt.publicReleaseReady, false, "A target package receipt must defer aggregate public readiness.");
    assert.equal(packageReceipt.runtimeReleaseReady, true, "Formal public performance evidence requires a release-ready runtime package.");
    assert.equal(packageReceipt.source.githubActions, true, "Formal public performance evidence must use a GitHub Actions package receipt.");
    assert.equal(packageReceipt.source.runnerEnvironment, "github-hosted", "Formal public performance evidence requires a GitHub-hosted package runner.");
    assert.match(packageReceipt.source.runId ?? "", /^\d{1,20}$/, "Formal public performance evidence lacks its source run id.");
    assert.match(packageReceipt.source.runAttempt ?? "", /^\d{1,10}$/, "Formal public performance evidence lacks its source run attempt.");
    assert.equal(packageReceipt.installerValidated, true, "Formal public performance evidence requires a validated installer.");
    assert.equal(packageReceipt.unsignedPolicyValidated, true, "Formal public performance evidence requires the unsigned-distribution policy gate.");
    assert.equal(packageReceipt.platformSignatureStatus, "absent-by-policy", "Formal public performance evidence has an invalid signature policy status.");
    const inferredManifestPath = join(dirname(dirname(resolvedReceiptPath)), preparedManifestName);
    prepared = readBrainPetPreparedPerformanceManifest(preparedManifestPath || inferredManifestPath, { repoRoot });
    assertSameRealPath(prepared.paths.packageReceipt, resolvedReceiptPath, "Prepared candidate package receipt does not match BRAINPET_PACKAGE_RECEIPT.");
    assertSameRealPath(prepared.paths.executable, expectedExecutable, "Prepared candidate executable does not match BRAINPET_ELECTRON_EXECUTABLE.");
    validateBrainPetPackageArtifactClosure(dirname(resolvedReceiptPath), "windows-x64");
    assert.equal(packageReceipt.artifacts.length, 1, "Formal Windows performance evidence requires exactly one installer artifact.");
    assert.equal(packageReceipt.artifacts[0].kind, "nsis", "Formal Windows performance evidence requires the NSIS installer.");
    installer = resolveSafeRelative(dirname(resolvedReceiptPath), packageReceipt.artifacts[0].path, "packaged NSIS installer");
    assertSameRealPath(installer, prepared.paths.installer, "Prepared candidate installer does not match the package receipt.");
    receiptExecutable = prepared.paths.executable;
    appAsar = prepared.paths.appAsar;
    candidateReceipt = validatePreparedPublicCandidateReceipt(prepared, packageReceipt, packageReceiptBytes);
    provenanceSubjects = validatePreparedProvenance(prepared, {
      candidateReceipt: prepared.paths.candidateReceipt,
      packageReceipt: resolvedReceiptPath,
      installer,
    }, {
      verifier: provenanceVerifier,
      repository: packageReceipt.source.repository,
      sourceCommit: packageReceipt.source.commit,
    });
    assertPreparedManifestBindings(prepared, { packageReceiptBytes, packageReceipt, candidateReceipt, installer, receiptExecutable, appAsar });
  } else {
    assert.equal(packageReceipt.packageTarget, "dir", "A private performance package must use the unpacked directory target.");
    assert.equal(packageReceipt.publicReleaseReady, false, "A local performance candidate must not claim public release readiness.");
    assert.equal(packageReceipt.runtimeReleaseReady, false, "An unpacked private-test package must not claim runtime release readiness.");
    assert.deepEqual(packageReceipt.artifacts, [], "An unpacked performance candidate must not carry installer artifacts.");
    assert.equal(packageReceipt.source.githubActions, false, "A private performance candidate must be locally built.");
    const receiptRoot = dirname(resolvedReceiptPath);
    receiptExecutable = resolveSafeRelative(receiptRoot, packageReceipt.executable, "packaged executable");
    assertSameRealPath(receiptExecutable, expectedExecutable, "BRAINPET_ELECTRON_EXECUTABLE does not match the package receipt.");
    appAsar = resolveSafeRelative(receiptRoot, packageReceipt.appAsar, "packaged app.asar");
  }
  assertRegularFile(receiptExecutable, "BrainPet packaged executable");
  const realReceiptExecutable = realpathSync.native(receiptExecutable);
  assertUnderRoot(realReceiptExecutable, prepared?.candidateRoot ?? dirname(resolvedReceiptPath), "BrainPet packaged executable");
  assert.equal(sha256File(realReceiptExecutable), packageReceipt.sha256, "BrainPet packaged executable bytes do not match the package receipt.");
  assertRegularFile(appAsar, "BrainPet packaged app.asar");
  const realAppAsar = realpathSync.native(appAsar);
  assertUnderRoot(realAppAsar, prepared?.candidateRoot ?? dirname(resolvedReceiptPath), "BrainPet packaged app.asar");
  assert.equal(sha256File(realAppAsar), packageReceipt.appAsarSha256, "BrainPet packaged app.asar bytes do not match the package receipt.");
  const runtimeRoot = prepared?.paths.runtimeRoot ?? dirname(realReceiptExecutable);
  assert.equal(dirname(realReceiptExecutable), runtimeRoot, "Prepared BrainPet executable is not at the runtime root.");
  validateBrainPetRuntimeTree(runtimeRoot, packageReceipt.runtimeTree);

  return Object.freeze({
    repository: gitIdentity.repository,
    commit: gitIdentity.commit,
    appVersion: packageReceipt.appVersion,
    target: packageReceipt.target,
    releaseMode: packageReceipt.releaseMode,
    packageTarget: packageReceipt.packageTarget,
    sourceRunId: packageReceipt.source.runId ?? null,
    sourceRunAttempt: packageReceipt.source.runAttempt ?? null,
    packageReceipt: toRepoRelative(resolvedRepoRoot, resolvedReceiptPath, "BrainPet package receipt"),
    packageReceiptSha256: sha256Bytes(packageReceiptBytes),
    executable: prepared ? toRepoRelative(resolvedRepoRoot, realReceiptExecutable, "BrainPet prepared executable") : packageReceipt.executable,
    executableSha256: packageReceipt.sha256,
    appAsar: prepared ? toRepoRelative(resolvedRepoRoot, realAppAsar, "BrainPet prepared app.asar") : packageReceipt.appAsar,
    appAsarSha256: packageReceipt.appAsarSha256,
    runtimeTreeDigest: packageReceipt.runtimeTree.digest,
    ...(prepared ? {
      preparedManifest: toRepoRelative(resolvedRepoRoot, prepared.paths.manifest, "BrainPet prepared manifest"),
      preparedManifestSha256: sha256File(prepared.paths.manifest),
      publicCandidateReceipt: toRepoRelative(resolvedRepoRoot, prepared.paths.candidateReceipt, "BrainPet public-candidate receipt"),
      publicCandidateReceiptSha256: sha256File(prepared.paths.candidateReceipt),
      installer: toRepoRelative(resolvedRepoRoot, installer, "BrainPet NSIS installer"),
      installerSha256: packageReceipt.artifacts[0].sha256,
      provenanceBundleSha256: provenanceSubjects.candidateReceipt.bundleSha256,
    } : {}),
  });
}

export function revalidateBrainPetPerformanceCandidate(candidate, { repoRoot = defaultRepoRoot, gitIdentity = resolveTrackedGitIdentity(repoRoot), platform = process.platform } = {}) {
  assertBrainPetPerformanceCandidateShape(candidate);
  const current = candidate.preparedManifest
    ? validateBrainPetPreparedPerformanceCandidate(resolve(repoRoot, candidate.preparedManifest), { repoRoot, gitIdentity, platform })
    : validateBrainPetPerformanceCandidate({ packageReceiptPath: resolve(repoRoot, candidate.packageReceipt), executablePath: resolve(dirname(resolve(repoRoot, candidate.packageReceipt)), candidate.executable), repoRoot, gitIdentity, platform });
  assert.deepEqual(current, candidate, "BrainPet performance candidate changed during the gate.");
  return current;
}

export function resolveBrainPetPerformanceReceiptPath(candidate, gateProfile, outputRoot = join(defaultRepoRoot, "output", "performance")) {
  assertFormalGateProfile(gateProfile);
  assert.match(candidate?.commit ?? "", /^[a-f0-9]{40}$/i, "Performance receipt candidate commit is invalid.");
  return resolve(outputRoot, `brainpet-${gateProfile}-${candidate.commit}.json`);
}

export function assertBrainPetPerformanceReceiptAvailable(receiptPath) {
  assert.equal(existsSync(receiptPath), false, `BrainPet performance receipt already exists and cannot be overwritten: ${receiptPath}`);
}

export async function writeBrainPetPerformanceReceipt({
  receiptPath,
  candidate,
  gateProfile,
  startedAt,
  gateResult,
  runEvidence,
  validatePublishedReceipt = validateBrainPetPerformanceReceipt,
  removePublishedReceipt = removePublishedBrainPetPerformanceReceipt,
}) {
  assertFormalGateProfile(gateProfile);
  const normalizedGateResult = normalizeBrainPetFormalGateResult(gateResult, gateProfile);
  assertBrainPetPerformanceCandidateShape(candidate);
  assertRunEvidence(runEvidence);
  assert.equal(basename(receiptPath), `brainpet-${gateProfile}-${candidate.commit}.json`, "Performance receipt path does not match its candidate and profile.");
  const started = new Date(startedAt);
  assert.equal(Number.isNaN(started.getTime()), false, "Performance receipt start time is invalid.");
  const core = {
    schemaVersion: 2,
    kind: "brainpet-performance-gate",
    product: "brainpet",
    gateProfile,
    gatePassed: true,
    startedAt: started.toISOString(),
    completedAt: new Date().toISOString(),
    candidate,
    runEvidence,
    gateResult: normalizedGateResult,
  };
  assertBrainPetPerformanceWallClock(core.startedAt, core.completedAt, brainPetFormalPerformanceContract[gateProfile].durationMs);
  const receipt = { ...core, evidenceDigest: sha256Bytes(Buffer.from(JSON.stringify(core))) };
  let published = false;
  try {
    await writeJsonExclusiveAtomic(receiptPath, receipt);
    published = true;
    const validated = validatePublishedReceipt(receiptPath, { candidate, gateProfile });
    return { path: resolve(receiptPath), sha256: sha256File(receiptPath), receipt: validated };
  } catch (error) {
    if (published) {
      try {
        await removePublishedReceipt(receiptPath);
      } catch (cleanupError) {
        throw new BrainPetPerformanceReceiptRollbackError([error, cleanupError], receiptPath);
      }
    }
    throw error;
  }
}

export async function removePublishedBrainPetPerformanceReceipt(receiptPath, removeReceipt = rm) {
  await removeReceipt(receiptPath, { force: true });
  assert.equal(existsSync(receiptPath), false, "BrainPet published performance receipt remained after rollback.");
}

export function validateBrainPetPerformanceReceipt(receiptPath, { candidate, gateProfile } = {}) {
  assertRegularFile(receiptPath, "BrainPet performance receipt", 16 * 1024 * 1024);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.kind, "brainpet-performance-gate");
  assert.equal(receipt.product, "brainpet");
  assertFormalGateProfile(receipt.gateProfile);
  assert.equal(receipt.gatePassed, true);
  assert.equal(receipt.gateResult?.ok, true);
  assert.equal(receipt.gateResult?.gateProfile, receipt.gateProfile);
  assert.equal(receipt.gateResult?.gatePassed, true);
  assertBrainPetPerformanceCandidateShape(receipt.candidate);
  assertRunEvidence(receipt.runEvidence);
  assert.match(receipt.evidenceDigest ?? "", /^[a-f0-9]{64}$/i);
  const { evidenceDigest, ...core } = receipt;
  assert.equal(evidenceDigest, sha256Bytes(Buffer.from(JSON.stringify(core))), "BrainPet performance receipt evidence digest is invalid.");
  validateBrainPetFormalGateResult(receipt.gateResult, receipt.gateProfile);
  assert.equal(basename(receiptPath), `brainpet-${receipt.gateProfile}-${receipt.candidate.commit}.json`, "BrainPet performance receipt filename does not match its evidence.");
  const startedAt = Date.parse(receipt.startedAt);
  const completedAt = Date.parse(receipt.completedAt);
  assert.equal(Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt, true, "BrainPet performance receipt timestamps are invalid.");
  assertBrainPetPerformanceWallClock(receipt.startedAt, receipt.completedAt, brainPetFormalPerformanceContract[receipt.gateProfile].durationMs);
  if (gateProfile !== undefined) assert.equal(receipt.gateProfile, gateProfile, "BrainPet performance receipt profile mismatch.");
  if (candidate !== undefined) assert.deepEqual(receipt.candidate, candidate, "BrainPet performance receipt candidate mismatch.");
  return receipt;
}

export async function writeJsonExclusiveAtomic(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${relative(dirname(target), target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertFormalGateProfile(gateProfile) {
  assert.equal(formalGateProfiles.has(gateProfile), true, `Unknown formal BrainPet performance profile: ${gateProfile}`);
}

function assertBrainPetPerformanceCandidateShape(candidate) {
  assert.ok(candidate && typeof candidate === "object" && !Array.isArray(candidate), "Performance receipt candidate binding is incomplete.");
  assert.equal(candidate.repository, brainPetDistributionContract.identity.repository);
  assert.match(candidate.commit ?? "", /^[a-f0-9]{40}$/i);
  assert.match(candidate.appVersion ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(candidate.target, "windows-x64");
  assert.ok(["private-test", "public-release"].includes(candidate.releaseMode), "Performance candidate release mode is invalid.");
  assert.ok(["dir", "installer"].includes(candidate.packageTarget), "Performance candidate package target is invalid.");
  assertPortableRelativePath(candidate.packageReceipt, "candidate package receipt");
  assertPortableRelativePath(candidate.executable, "candidate executable");
  assertPortableRelativePath(candidate.appAsar, "candidate app.asar");
  assert.match(candidate.packageReceiptSha256 ?? "", /^[a-f0-9]{64}$/i);
  assert.match(candidate.executableSha256 ?? "", /^[a-f0-9]{64}$/i);
  assert.match(candidate.appAsarSha256 ?? "", /^[a-f0-9]{64}$/i);
  assert.match(candidate.runtimeTreeDigest ?? "", /^[a-f0-9]{64}$/i);
  if (candidate.releaseMode === "public-release") {
    assert.equal(candidate.packageTarget, "installer");
    assert.match(candidate.sourceRunId ?? "", /^\d{1,20}$/);
    assert.match(candidate.sourceRunAttempt ?? "", /^\d{1,10}$/);
    for (const [key, label] of [["preparedManifest", "candidate prepared manifest"], ["publicCandidateReceipt", "candidate public receipt"], ["installer", "candidate installer"]]) assertPortableRelativePath(candidate[key], label);
    for (const key of ["preparedManifestSha256", "publicCandidateReceiptSha256", "installerSha256", "provenanceBundleSha256"]) assert.match(candidate[key] ?? "", /^[a-f0-9]{64}$/i, `Performance candidate ${key} is invalid.`);
  } else {
    assert.equal(candidate.packageTarget, "dir");
    assert.equal(candidate.sourceRunId, null);
    assert.equal(candidate.sourceRunAttempt, null);
  }
}

function assertPreparedPerformanceManifestCore(core) {
  assert.ok(core && typeof core === "object" && !Array.isArray(core), "Prepared BrainPet performance manifest is invalid.");
  assert.equal(core.schemaVersion, 1);
  assert.equal(core.kind, "brainpet-public-performance-candidate");
  assert.equal(core.repository, brainPetDistributionContract.identity.repository);
  assert.match(core.sourceCommit ?? "", /^[a-f0-9]{40}$/i);
  assert.match(core.sourceRunId ?? "", /^\d{1,20}$/);
  assert.match(core.sourceRunAttempt ?? "", /^\d{1,10}$/);
  assert.equal(core.workflow, "BrainPet public release gate");
  assert.equal(Number.isNaN(Date.parse(core.preparedAt)), false, "Prepared BrainPet candidate timestamp is invalid.");
  const fixedPaths = {
    candidateReceipt: "candidate-receipt/brainpet-release-receipt.json",
    packageReceipt: "package/brainpet-package-receipt-windows-x64.json",
    runtimeRoot: "runtime",
    executable: "runtime/brainpet.exe",
    appAsar: "runtime/resources/app.asar",
  };
  for (const [key, expected] of Object.entries(fixedPaths)) assert.equal(core[key], expected, `Prepared BrainPet candidate ${key} path is invalid.`);
  assertPortableRelativePath(core.installer, "prepared candidate installer");
  assert.equal(core.installer.startsWith("package/"), true, "Prepared BrainPet installer must stay in its package closure.");
  for (const key of ["candidateReceiptSha256", "packageReceiptSha256", "installerSha256", "executableSha256", "appAsarSha256", "runtimeTreeDigest"]) assert.match(core[key] ?? "", /^[a-f0-9]{64}$/i, `Prepared BrainPet candidate ${key} is invalid.`);
  assert.ok(Array.isArray(core.provenance) && core.provenance.length === 3, "Prepared BrainPet candidate must bind exactly three provenance bundles.");
  assert.deepEqual(core.provenance.map((entry) => entry.subject).sort(), ["candidate-receipt", "installer", "package-receipt"], "Prepared BrainPet provenance subjects are invalid.");
  for (const entry of core.provenance) {
    assertPortableRelativePath(entry.bundle, `prepared ${entry.subject} provenance bundle`);
    assert.equal(entry.bundle.startsWith("provenance/"), true, `Prepared ${entry.subject} provenance bundle escaped its directory.`);
    assert.match(entry.subjectSha256 ?? "", /^[a-f0-9]{64}$/i);
    assert.match(entry.bundleSha256 ?? "", /^[a-f0-9]{64}$/i);
  }
}

function validatePreparedPublicCandidateReceipt(prepared, packageReceipt, packageReceiptBytes) {
  assertRegularFile(prepared.paths.candidateReceipt, "BrainPet public-candidate receipt", 2 * 1024 * 1024);
  const receipt = JSON.parse(readFileSync(prepared.paths.candidateReceipt, "utf8"));
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.product, "brainpet");
  assert.equal(receipt.appId, brainPetDistributionContract.identity.appId);
  assert.equal(receipt.releaseMode, "public-release");
  assert.equal(receipt.sourceCommit.toLowerCase(), packageReceipt.source.commit.toLowerCase());
  assert.equal(String(receipt.sourceRunId), String(packageReceipt.source.runId));
  assert.equal(String(receipt.sourceRunAttempt), String(packageReceipt.source.runAttempt));
  assert.equal(receipt.rc6GatePassed, true);
  assert.equal(receipt.publicReleaseReady, false);
  assert.deepEqual([...receipt.missingEvidence].sort(), [...publicCandidateMissingEvidence].sort(), "Prepared public candidate has an unexpected evidence state.");
  assert.match(receipt.physicalChallenge ?? "", /^[a-f0-9]{64}$/i);
  assert.ok(Array.isArray(receipt.packages) && receipt.packages.length === brainPetReleaseTargets.length, "Prepared public candidate package set is incomplete.");
  assert.deepEqual(receipt.packages.map((entry) => entry.target).sort(), brainPetReleaseTargets.map((entry) => entry.id).sort(), "Prepared public candidate target set is invalid.");
  const windowsPackage = receipt.packages.find((entry) => entry.target === "windows-x64");
  assert.deepEqual(windowsPackage, { ...packageReceipt, provenanceValidated: true }, "Prepared Windows package receipt differs from the public aggregate receipt.");
  assert.equal(prepared.manifest.candidateReceiptSha256, sha256File(prepared.paths.candidateReceipt), "Prepared public-candidate receipt hash changed.");
  assert.equal(prepared.manifest.packageReceiptSha256, sha256Bytes(packageReceiptBytes), "Prepared package receipt hash changed.");
  const { evidenceDigest, generatedAt: _generatedAt, ...core } = receipt;
  assert.equal(evidenceDigest, sha256Bytes(Buffer.from(JSON.stringify(core))), "Prepared public-candidate receipt evidence digest is invalid.");
  return receipt;
}

function validatePreparedProvenance(prepared, subjects, verification) {
  assert.equal(typeof verification.verifier, "function", "Prepared BrainPet provenance requires a Sigstore verifier.");
  const records = {};
  for (const entry of prepared.manifest.provenance) {
    const subjectPath = subjects[entry.subject === "candidate-receipt" ? "candidateReceipt" : entry.subject === "package-receipt" ? "packageReceipt" : "installer"];
    assertRegularFile(subjectPath, `Prepared ${entry.subject} provenance subject`);
    const subjectSha256 = sha256File(subjectPath);
    assert.equal(entry.subjectSha256, subjectSha256, `Prepared ${entry.subject} provenance subject hash changed.`);
    const expectedBundleName = `sha256-${subjectSha256}.sigstore.json`;
    assert.equal(basename(entry.bundle), expectedBundleName, `Prepared ${entry.subject} provenance bundle name is invalid.`);
    const bundlePath = resolveSafeRelative(prepared.candidateRoot, entry.bundle, `prepared ${entry.subject} provenance bundle`);
    assertRegularFile(bundlePath, `Prepared ${entry.subject} provenance bundle`, 2 * 1024 * 1024);
    assert.doesNotThrow(() => JSON.parse(readFileSync(bundlePath, "utf8")), `Prepared ${entry.subject} provenance bundle is not JSON.`);
    const bundleSha256 = sha256File(bundlePath);
    assert.equal(entry.bundleSha256, bundleSha256, `Prepared ${entry.subject} provenance bundle hash changed.`);
    verification.verifier({
      subjectPath,
      bundlePath,
      repository: verification.repository,
      workflowPath: brainPetPublicReleaseWorkflow.path,
      workflowName: brainPetPublicReleaseWorkflow.name,
      sourceCommit: verification.sourceCommit,
      label: `BrainPet prepared ${entry.subject}`,
    });
    records[entry.subject === "candidate-receipt" ? "candidateReceipt" : entry.subject === "package-receipt" ? "packageReceipt" : "installer"] = { subjectSha256, bundleSha256 };
  }
  return records;
}

function assertPreparedManifestBindings(prepared, values) {
  const manifest = prepared.manifest;
  assert.equal(manifest.repository, values.packageReceipt.source.repository);
  assert.equal(manifest.sourceCommit.toLowerCase(), values.packageReceipt.source.commit.toLowerCase());
  assert.equal(String(manifest.sourceRunId), String(values.packageReceipt.source.runId));
  assert.equal(String(manifest.sourceRunAttempt), String(values.packageReceipt.source.runAttempt));
  assert.equal(manifest.installerSha256, sha256File(values.installer), "Prepared BrainPet installer bytes changed.");
  assert.equal(manifest.executableSha256, sha256File(values.receiptExecutable), "Prepared BrainPet executable bytes changed.");
  assert.equal(manifest.appAsarSha256, sha256File(values.appAsar), "Prepared BrainPet app.asar bytes changed.");
  assert.equal(manifest.runtimeTreeDigest, values.packageReceipt.runtimeTree.digest, "Prepared BrainPet runtime-tree binding changed.");
}

function assertRunEvidence(evidence) {
  assert.ok(evidence && typeof evidence === "object" && !Array.isArray(evidence), "BrainPet performance receipt lacks runner evidence.");
  assert.match(evidence.runId ?? "", /^(?:active-30m|idle-24h)-[a-f0-9]{40}-\d{13}-[a-f0-9-]{36}$/i, "BrainPet performance runner id is invalid.");
  for (const key of ["manifestSha256", "resultSha256", "executionLogSha256", "completionCoreDigest"]) assert.match(evidence[key] ?? "", /^[a-f0-9]{64}$/i, `BrainPet performance runner ${key} is invalid.`);
  assert.ok(Number.isInteger(evidence.executionLogBytes) && evidence.executionLogBytes > 0, "BrainPet performance execution-log length is invalid.");
}

function assertPortableRelativePath(value, label) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 4096 && !isAbsolute(value) && !value.includes("\\") && !value.includes("\0") && !value.includes(":"), `${label} path is invalid.`);
  const segments = value.split("/");
  assert.ok(segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), `${label} path is invalid.`);
}

function resolveSafeRelative(root, value, label) {
  assertPortableRelativePath(value, label);
  const path = resolve(root, value);
  assertUnderRoot(path, root, label);
  return path;
}

function assertUnderRoot(path, root, label) {
  const child = relative(resolve(root), resolve(path));
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child), `${label} must stay under its evidence root.`);
}

function toRepoRelative(repoRoot, path, label) {
  assertUnderRoot(path, repoRoot, label);
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function assertRegularFile(path, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file.`);
  assert.ok(stat.size > 0 && stat.size <= maximumBytes, `${label} has an invalid size.`);
}

function assertSameRealPath(left, right, message) {
  const normalize = (value) => {
    const real = realpathSync.native(value);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  assert.equal(normalize(left), normalize(right), message);
}
