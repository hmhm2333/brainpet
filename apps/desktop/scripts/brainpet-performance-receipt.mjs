#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "../../../scripts/brainpet-release-contract.mjs";
import { assertBrainPetPerformanceWallClock } from "../../../scripts/brainpet-performance-metrics-contract.mjs";
import { brainPetFormalPerformanceContract, normalizeBrainPetFormalGateResult, validateBrainPetFormalGateResult } from "./brainpet-performance-contract.mjs";
import { validateBrainPetRuntimeTree, validateBrainPetRuntimeTreeShape } from "./brainpet-runtime-tree.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const defaultRepoRoot = resolve(appDir, "..", "..");
const formalGateProfiles = new Set(["active-30m", "idle-24h"]);

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

export function validateBrainPetPerformanceCandidate({ packageReceiptPath, executablePath, repoRoot = defaultRepoRoot, gitIdentity = resolveTrackedGitIdentity(repoRoot), platform = process.platform }) {
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
  assert.equal(packageReceipt.releaseMode, "private-test", "Formal local performance evidence must use a private-test package.");
  assert.equal(packageReceipt.packageTarget, "dir", "Formal local performance evidence must use the unpacked directory package.");
  assert.equal(packageReceipt.publicReleaseReady, false, "A local performance candidate must not claim public release readiness.");
  assert.equal(packageReceipt.runtimeReleaseReady, false, "An unpacked private-test package must not claim runtime release readiness.");
  assert.deepEqual(packageReceipt.artifacts, [], "An unpacked performance candidate must not carry installer artifacts.");
  assert.ok(packageReceipt.source && typeof packageReceipt.source === "object", "BrainPet package receipt lacks source identity.");
  assert.equal(packageReceipt.source.repository, gitIdentity.repository, "BrainPet package receipt repository does not match the current checkout.");
  assert.equal(packageReceipt.source.commit, gitIdentity.commit, "BrainPet package receipt commit does not match the current checkout.");
  assert.equal(packageReceipt.source.treeDirty, false, "BrainPet package receipt was built from a dirty tracked worktree.");
  assert.equal(packageReceipt.source.githubActions, false, "Formal local performance evidence must use a locally built package receipt.");
  assert.match(packageReceipt.appVersion ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "BrainPet package receipt has an invalid app version.");
  assert.match(packageReceipt.sha256 ?? "", /^[a-f0-9]{64}$/i, "BrainPet package receipt lacks an executable hash.");
  assert.match(packageReceipt.appAsarSha256 ?? "", /^[a-f0-9]{64}$/i, "BrainPet package receipt lacks an app.asar hash.");
  validateBrainPetRuntimeTreeShape(packageReceipt.runtimeTree);

  const receiptRoot = dirname(resolvedReceiptPath);
  const receiptExecutable = resolveSafeRelative(receiptRoot, packageReceipt.executable, "packaged executable");
  const expectedExecutable = resolve(executablePath);
  assertSameRealPath(receiptExecutable, expectedExecutable, "BRAINPET_ELECTRON_EXECUTABLE does not match the package receipt.");
  assertRegularFile(receiptExecutable, "BrainPet packaged executable");
  const realReceiptExecutable = realpathSync.native(receiptExecutable);
  assertUnderRoot(realReceiptExecutable, receiptRoot, "BrainPet packaged executable");
  assert.equal(sha256File(realReceiptExecutable), packageReceipt.sha256, "BrainPet packaged executable bytes do not match the package receipt.");

  const appAsar = resolveSafeRelative(receiptRoot, packageReceipt.appAsar, "packaged app.asar");
  assertRegularFile(appAsar, "BrainPet packaged app.asar");
  const realAppAsar = realpathSync.native(appAsar);
  assertUnderRoot(realAppAsar, receiptRoot, "BrainPet packaged app.asar");
  assert.equal(sha256File(realAppAsar), packageReceipt.appAsarSha256, "BrainPet packaged app.asar bytes do not match the package receipt.");
  const runtimeRoot = dirname(realReceiptExecutable);
  validateBrainPetRuntimeTree(runtimeRoot, packageReceipt.runtimeTree);

  return Object.freeze({
    repository: gitIdentity.repository,
    commit: gitIdentity.commit,
    appVersion: packageReceipt.appVersion,
    target: packageReceipt.target,
    packageReceipt: toRepoRelative(resolvedRepoRoot, resolvedReceiptPath, "BrainPet package receipt"),
    packageReceiptSha256: sha256Bytes(packageReceiptBytes),
    executable: packageReceipt.executable,
    executableSha256: packageReceipt.sha256,
    appAsar: packageReceipt.appAsar,
    appAsarSha256: packageReceipt.appAsarSha256,
    runtimeTreeDigest: packageReceipt.runtimeTree.digest,
  });
}

export function revalidateBrainPetPerformanceCandidate(candidate, { repoRoot = defaultRepoRoot, gitIdentity = resolveTrackedGitIdentity(repoRoot), platform = process.platform } = {}) {
  assertBrainPetPerformanceCandidateShape(candidate);
  const packageReceiptPath = resolve(repoRoot, candidate.packageReceipt);
  const executablePath = resolve(dirname(packageReceiptPath), candidate.executable);
  const current = validateBrainPetPerformanceCandidate({ packageReceiptPath, executablePath, repoRoot, gitIdentity, platform });
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

export async function writeBrainPetPerformanceReceipt({ receiptPath, candidate, gateProfile, startedAt, gateResult, runEvidence }) {
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
  const receipt = { ...core, evidenceDigest: sha256Bytes(Buffer.from(JSON.stringify(core))) };
  await writeJsonExclusiveAtomic(receiptPath, receipt);
  const validated = validateBrainPetPerformanceReceipt(receiptPath, { candidate, gateProfile });
  return { path: resolve(receiptPath), sha256: sha256File(receiptPath), receipt: validated };
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
  assertPortableRelativePath(candidate.packageReceipt, "candidate package receipt");
  assertPortableRelativePath(candidate.executable, "candidate executable");
  assertPortableRelativePath(candidate.appAsar, "candidate app.asar");
  assert.match(candidate.packageReceiptSha256 ?? "", /^[a-f0-9]{64}$/i);
  assert.match(candidate.executableSha256 ?? "", /^[a-f0-9]{64}$/i);
  assert.match(candidate.appAsarSha256 ?? "", /^[a-f0-9]{64}$/i);
  assert.match(candidate.runtimeTreeDigest ?? "", /^[a-f0-9]{64}$/i);
}

function assertRunEvidence(evidence) {
  assert.ok(evidence && typeof evidence === "object" && !Array.isArray(evidence), "BrainPet performance receipt lacks runner evidence.");
  assert.match(evidence.runId ?? "", /^(?:active-30m|idle-24h)-[a-f0-9]{40}-\d{13}-[a-f0-9-]{36}$/i, "BrainPet performance runner id is invalid.");
  for (const key of ["manifestSha256", "resultSha256", "executionLogSha256", "completionCoreDigest"]) assert.match(evidence[key] ?? "", /^[a-f0-9]{64}$/i, `BrainPet performance runner ${key} is invalid.`);
  assert.ok(Number.isInteger(evidence.executionLogBytes) && evidence.executionLogBytes > 0, "BrainPet performance execution-log length is invalid.");
}

function assertPortableRelativePath(value, label) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 4096 && !isAbsolute(value) && !value.split(/[\\/]/).includes(".."), `${label} path is invalid.`);
}

function resolveSafeRelative(root, value, label) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 4096 && !isAbsolute(value), `${label} path is invalid.`);
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
