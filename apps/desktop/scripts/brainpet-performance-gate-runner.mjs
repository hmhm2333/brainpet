#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "../../../scripts/brainpet-release-contract.mjs";
import { validateBrainPetFormalGateResult } from "./brainpet-performance-contract.mjs";
import {
  assertBrainPetPerformanceReceiptAvailable,
  BrainPetPerformanceReceiptRollbackError,
  revalidateBrainPetPerformanceCandidate,
  removePublishedBrainPetPerformanceReceipt,
  resolveBrainPetPerformanceReceiptPath,
  resolveTrackedGitIdentity,
  sha256Bytes,
  sha256File,
  validateBrainPetPreparedPerformanceCandidate,
  validateBrainPetPerformanceReceipt,
  writeBrainPetPerformanceReceipt,
  writeJsonExclusiveAtomic,
} from "./brainpet-performance-receipt.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const appDir = resolve(scriptDir, "..");
const repoRoot = resolve(appDir, "..", "..");
const realRepoRoot = realpathSync.native(repoRoot);
const performanceRoot = join(repoRoot, "output", "performance");
const runsRoot = join(performanceRoot, "runs");
const leasePath = join(performanceRoot, "brainpet-performance-gate.lease.json");
const defaultPerformancePaths = Object.freeze({ performanceRoot, runsRoot, leasePath });
const profiles = Object.freeze({
  "active-30m": Object.freeze({ soakMs: "1800000", task: "cargo-signal" }),
  "idle-24h": Object.freeze({ idleSoakMs: "86400000" }),
});

export function createBrainPetPerformanceGatePaths(root) {
  const isolatedPerformanceRoot = resolve(root);
  assertSafeEvidencePath(isolatedPerformanceRoot, false);
  return Object.freeze({
    performanceRoot: isolatedPerformanceRoot,
    runsRoot: join(isolatedPerformanceRoot, "runs"),
    leasePath: join(isolatedPerformanceRoot, "brainpet-performance-gate.lease.json"),
  });
}

export async function startBrainPetPerformanceGate(profile, candidateManifestPath) {
  assert.equal(process.platform, "win32", "The detached BrainPet performance runner currently requires Windows.");
  assertPerformanceProfile(profile);
  const source = resolveTrackedGitIdentity(repoRoot);
  assert.equal(source.treeDirty, false, "A formal BrainPet performance run requires a clean tracked worktree.");
  assert.ok(typeof candidateManifestPath === "string" && candidateManifestPath.length > 0, "A formal BrainPet performance run requires --candidate <prepared-manifest>.");
  const resolvedCandidateManifestPath = isAbsolute(candidateManifestPath) ? resolve(candidateManifestPath) : resolve(repoRoot, candidateManifestPath);
  const candidate = validateBrainPetPreparedPerformanceCandidate(resolvedCandidateManifestPath, { repoRoot, gitIdentity: source });
  assert.equal(candidate.releaseMode, "public-release", "Formal BrainPet performance evidence requires a public-release candidate.");
  assert.equal(candidate.packageTarget, "installer", "Formal BrainPet performance evidence requires the public installer candidate.");
  assert.equal(candidate.commit, source.commit, "Prepared BrainPet candidate does not match the current source commit.");
  await ensureSafeEvidenceDirectory(runsRoot);
  const runId = `${profile}-${source.commit}-${Date.now()}-${randomUUID()}`;
  const manifestPath = join(runsRoot, `${runId}.manifest.json`);
  const completionPath = join(runsRoot, `${runId}.completion.json`);
  const resultPath = join(runsRoot, `${runId}.result.json`);
  const logPath = join(runsRoot, `${runId}.log`);
  const expectedReceiptPath = resolveBrainPetPerformanceReceiptPath(source, profile, performanceRoot);
  recoverOrRejectPerformanceLease();
  assertBrainPetPerformanceReceiptAvailable(expectedReceiptPath);
  await acquirePerformanceLease({ runId, profile, manifest: toRepoRelative(manifestPath), owner: currentProcessIdentity() });
  let logDescriptor = null;
  let child;
  try {
    logDescriptor = openSync(logPath, "wx", 0o600);
    child = spawn(process.execPath, [scriptPath, "worker", "--profile", profile, "--run-id", runId, "--manifest", manifestPath, "--completion", completionPath], {
      cwd: repoRoot,
      detached: true,
      env: createCleanPerformanceEnvironment({ BRAINPET_GATE_RUN_ID: runId }),
      stdio: ["ignore", logDescriptor, logDescriptor],
      windowsHide: true,
    });
    assert.ok(Number.isInteger(child.pid) && child.pid > 0, "Detached BrainPet gate worker lacks a PID.");
    const runnerIdentity = await waitForWindowsProcessIdentity(child.pid, 5_000);
    const manifest = {
      schemaVersion: 3,
      kind: "brainpet-performance-gate-run",
      runId,
      profile,
      source,
      startedAt: new Date().toISOString(),
      expectedReceipt: toRepoRelative(expectedReceiptPath),
      result: toRepoRelative(resultPath),
      log: toRepoRelative(logPath),
      completion: toRepoRelative(completionPath),
      preparedCandidateManifest: toRepoRelative(resolvedCandidateManifestPath),
      preparedCandidateManifestSha256: sha256File(resolvedCandidateManifestPath),
      candidate,
      lease: toRepoRelative(leasePath),
      runner: {
        pid: child.pid,
        creationDate: runnerIdentity.creationDate,
        executable: process.execPath,
        commandNeedles: [basename(scriptPath), "worker", runId],
      },
    };
    // The worker cannot observe the manifest until the startup process has handed it
    // exclusive lease-writer ownership. This prevents a parent/worker RMW race from
    // overwriting activeChild during startup.
    await handoffPerformanceLeaseAndPublishManifest({ runId, startingOwner: currentProcessIdentity(), workerOwner: manifest.runner, manifestPath, manifest });
    child.unref();
    return { manifestPath, manifest };
  } catch (error) {
    child?.kill();
    await Promise.all([manifestPath, completionPath, resultPath, logPath].map((path) => rm(path, { recursive: true, force: true }).catch(() => {})));
    releaseOwnedLease(runId);
    throw error;
  } finally {
    if (logDescriptor !== null) closeSync(logDescriptor);
  }
}

export function readBrainPetPerformanceGateStatus(manifestPath, queryProcessIdentity = queryWindowsProcessIdentity, paths = defaultPerformancePaths) {
  assertSafeEvidencePath(manifestPath, true);
  const resolvedManifestPath = resolve(manifestPath);
  const manifest = readJsonRegularFile(resolvedManifestPath, 128 * 1024, "BrainPet performance run manifest");
  validateManifest(manifest, resolvedManifestPath, paths.leasePath, paths.runsRoot);
  const expectedReceiptPath = resolveRepoRelative(manifest.expectedReceipt, "expected performance receipt");
  const completionPath = resolveRepoRelative(manifest.completion, "performance completion record");
  const resultPath = resolveRepoRelative(manifest.result, "performance gate result");
  const logPath = resolveRepoRelative(manifest.log, "performance run log");
  if (existsSync(completionPath)) {
    assertSafeEvidencePath(completionPath, true);
    const completion = readJsonRegularFile(completionPath, 128 * 1024, "BrainPet performance completion record");
    validateCompletionCore(completion, manifest, resolvedManifestPath);
    assertLogPrefix(logPath, completion.executionLogBytes, completion.executionLogSha256);
    if (completion.succeeded) {
      assert.equal(completion.exitCode, 0);
      assert.equal(completion.error, null);
      const gateFile = readJsonRegularFile(resultPath, 16 * 1024 * 1024, "BrainPet formal gate result");
      assert.equal(sha256File(resultPath), completion.resultSha256, "BrainPet completion references different formal-result bytes.");
      validateGateFile(gateFile, manifest);
      const receipt = validateBrainPetPerformanceReceipt(expectedReceiptPath, { gateProfile: manifest.profile });
      assert.equal(receipt.candidate.commit, manifest.source.commit, "BrainPet performance receipt source commit does not match its run manifest.");
      assert.deepEqual(receipt.candidate, gateFile.candidate, "BrainPet receipt candidate differs from the sealed formal result.");
      assert.deepEqual(receipt.gateResult, gateFile.gateResult, "BrainPet receipt result differs from the sealed formal result.");
      assert.equal(sha256File(expectedReceiptPath), completion.receiptSha256, "BrainPet completion references different performance-receipt bytes.");
      assert.deepEqual(receipt.runEvidence, pickRunEvidence(completion), "BrainPet performance receipt does not bind its exact runner evidence.");
      return { state: "passed", manifestPath: resolvedManifestPath, manifest, completion, receiptPath: expectedReceiptPath, logPath };
    }
    assert.notEqual(completion.exitCode, 0);
    assert.ok(typeof completion.error === "string" && completion.error.length > 0 && completion.error.length <= 4096, "Failed BrainPet performance completion lacks a bounded error.");
    assert.equal(existsSync(expectedReceiptPath), false, "Failed BrainPet performance run left a success receipt.");
    if (completion.resultSha256 === null) assert.equal(existsSync(resultPath), false, "Failed BrainPet performance run left an unsealed formal result.");
    else assert.equal(sha256File(resultPath), completion.resultSha256, "Failed BrainPet completion references different formal-result bytes.");
    return { state: "failed", manifestPath: resolvedManifestPath, manifest, completion, receiptPath: null, logPath };
  }
  const identity = queryProcessIdentity(manifest.runner.pid);
  const exactRunner = matchesProcessIdentity(identity, manifest.runner);
  let orphanedReceiptPath = null;
  if (!exactRunner && existsSync(expectedReceiptPath)) {
    const gateFile = readJsonRegularFile(resultPath, 16 * 1024 * 1024, "interrupted BrainPet formal gate result");
    validateGateFile(gateFile, manifest);
    const receipt = validateBrainPetPerformanceReceipt(expectedReceiptPath, { candidate: gateFile.candidate, gateProfile: manifest.profile });
    assert.equal(receipt.runEvidence.runId, manifest.runId, "Interrupted BrainPet receipt came from a different run.");
    assert.equal(receipt.runEvidence.manifestSha256, sha256File(resolvedManifestPath), "Interrupted BrainPet receipt does not bind its manifest.");
    assert.equal(receipt.runEvidence.resultSha256, sha256File(resultPath), "Interrupted BrainPet receipt does not bind its formal result.");
    assertLogPrefix(logPath, receipt.runEvidence.executionLogBytes, receipt.runEvidence.executionLogSha256);
    orphanedReceiptPath = expectedReceiptPath;
  }
  return { state: exactRunner ? "running" : "interrupted", manifestPath: resolvedManifestPath, manifest, completion: null, receiptPath: orphanedReceiptPath, logPath, runnerIdentity: identity };
}

export function listBrainPetPerformanceRunManifests(profile) {
  if (!existsSync(runsRoot)) return [];
  assertSafeEvidencePath(runsRoot, true);
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".manifest.json"))
    .map((entry) => join(runsRoot, entry.name))
    .filter((path) => {
      if (!profile) return true;
      try { return JSON.parse(readFileSync(path, "utf8")).profile === profile; } catch { return true; }
    })
    .sort((left, right) => lstatSync(right).mtimeMs - lstatSync(left).mtimeMs);
}

export function queryWindowsProcessIdentity(pid) {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return null;
  const script = String.raw`
$processId = [uint32]$env:BRAINPET_RUNNER_PID
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" | Select-Object -First 1
if ($null -eq $process) { exit 3 }
[pscustomobject]@{ processId = [uint32]$process.ProcessId; creationDate = $process.CreationDate.ToUniversalTime().ToString('o'); executablePath = [string]$process.ExecutablePath; commandLine = [string]$process.CommandLine } | ConvertTo-Json -Compress
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { ...createCleanPerformanceEnvironment(), BRAINPET_RUNNER_PID: String(pid) }, encoding: "utf8", windowsHide: true,
  });
  if (result.status !== 0) return null;
  try {
    const identity = JSON.parse(result.stdout.trim());
    return Number(identity.processId) === pid && typeof identity.creationDate === "string" && typeof identity.executablePath === "string" && typeof identity.commandLine === "string" ? identity : null;
  } catch { return null; }
}

export function createCleanPerformanceEnvironment(overrides = {}) {
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "WINDIR", "ComSpec", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "ProgramData", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "PNPM_HOME"];
  const environment = new Map();
  for (const key of allowed) {
    if (!environment.has(key.toLowerCase()) && typeof process.env[key] === "string") environment.set(key.toLowerCase(), [key, process.env[key]]);
  }
  for (const [key, value] of Object.entries(overrides)) environment.set(key.toLowerCase(), [key, value]);
  return Object.fromEntries(environment.values());
}

export function recoverOrRejectPerformanceLease(queryProcessIdentity = queryWindowsProcessIdentity, terminateProcessTree = terminateWindowsProcessTree, paths = defaultPerformancePaths) {
  if (!existsSync(paths.leasePath)) return false;
  assertSafeEvidencePath(paths.leasePath, true);
  const lease = readJsonRegularFile(paths.leasePath, 64 * 1024, "BrainPet performance lease");
  if (lease.manifest) {
    const manifestPath = resolveRepoRelative(lease.manifest, "performance lease manifest");
    if (existsSync(manifestPath)) {
      const status = readBrainPetPerformanceGateStatus(manifestPath, queryProcessIdentity, paths);
      assert.notEqual(status.state, "running", `BrainPet ${status.manifest.profile} is already running as PID ${status.manifest.runner.pid}.`);
      if (status.state === "interrupted" && status.receiptPath) rmSyncExact(status.receiptPath);
    } else if (matchesProcessIdentity(queryProcessIdentity(lease.owner?.pid), lease.owner)) {
      throw new Error(`BrainPet performance gate startup is already owned by PID ${lease.owner.pid}.`);
    }
  } else if (matchesProcessIdentity(queryProcessIdentity(lease.owner?.pid), lease.owner)) {
    throw new Error(`BrainPet performance gate startup is already owned by PID ${lease.owner.pid}.`);
  }
  if (lease.activeChild) terminateProcessTree(lease.activeChild);
  rmSyncExact(paths.leasePath);
  return true;
}

async function runWorker(options) {
  assert.equal(process.platform, "win32", "The BrainPet performance worker currently requires Windows.");
  assertPerformanceProfile(options.profile);
  assert.match(options.runId ?? "", new RegExp(`^${escapeRegex(options.profile)}-[a-f0-9]{40}-\\d{13}-[a-f0-9-]{36}$`, "i"));
  const manifestPath = resolve(options.manifest);
  const completionPath = resolve(options.completion);
  await waitForPath(manifestPath, 30_000);
  const manifest = readJsonRegularFile(manifestPath, 128 * 1024, "BrainPet performance run manifest");
  validateManifest(manifest, manifestPath);
  assert.equal(manifest.runId, options.runId);
  assert.equal(manifest.profile, options.profile);
  const resultPath = resolveRepoRelative(manifest.result, "performance gate result");
  const logPath = resolveRepoRelative(manifest.log, "performance execution log");
  const receiptPath = resolveRepoRelative(manifest.expectedReceipt, "expected performance receipt");
  const manifestSha256 = sha256File(manifestPath);
  let completion;
  let writtenReceiptPath = null;
  try {
    const preparedManifestPath = resolveRepoRelative(manifest.preparedCandidateManifest, "prepared performance candidate manifest");
    assert.equal(sha256File(preparedManifestPath), manifest.preparedCandidateManifestSha256, "Prepared BrainPet candidate manifest changed before execution.");
    const candidate = validateBrainPetPreparedPerformanceCandidate(preparedManifestPath, { repoRoot });
    assert.deepEqual(candidate, manifest.candidate, "Prepared BrainPet candidate changed before execution.");
    const preparedExecutable = resolveRepoRelative(candidate.executable, "prepared BrainPet executable");
    const preparedReceipt = resolveRepoRelative(candidate.packageReceipt, "prepared BrainPet package receipt");
    const smokeEnvironment = createCleanPerformanceEnvironment({
      BRAINPET_GATE_RUN_ID: options.runId,
      BRAINPET_GATE_RESULT_PATH: resultPath,
      BRAINPET_PERFORMANCE_GATE: options.profile,
      BRAINPET_ENFORCE_RESOURCE_BUDGET: "1",
      BRAINPET_ELECTRON_EXECUTABLE: preparedExecutable,
      BRAINPET_PACKAGE_RECEIPT: preparedReceipt,
      ...(options.profile === "active-30m" ? { BRAINPET_SOAK_MS: profiles[options.profile].soakMs, BRAINPET_PERFORMANCE_EXECUTABLE: preparedExecutable, BRAINPET_SMOKE_TASK: profiles[options.profile].task } : { BRAINPET_IDLE_SOAK_MS: profiles[options.profile].idleSoakMs }),
    });
    const smokeExit = await runNodeScript(join(scriptDir, "brainpet-electron-smoke.mjs"), smokeEnvironment, options.runId, manifest.runner);
    if (smokeExit !== 0) throw new Error(`BrainPet ${options.profile} command exited with code ${smokeExit}.`);
    const gateFile = readJsonRegularFile(resultPath, 16 * 1024 * 1024, "BrainPet formal gate result");
    assert.equal(gateFile.schemaVersion, 1);
    assert.equal(gateFile.kind, "brainpet-performance-gate-result");
    assert.equal(gateFile.runId, options.runId);
    assert.equal(gateFile.gateProfile, options.profile);
    assert.deepEqual(gateFile.candidate, manifest.candidate, "Formal gate executed a different prepared candidate.");
    validateBrainPetFormalGateResult(gateFile.gateResult, options.profile);
    revalidateBrainPetPerformanceCandidate(gateFile.candidate, { repoRoot });
    const resultSha256 = sha256File(resultPath);
    await flushWritable(process.stdout);
    const executionLogBytes = statSync(logPath).size;
    const executionLogSha256 = sha256FilePrefix(logPath, executionLogBytes);
    const completedAt = new Date().toISOString();
    const completionCore = { runId: options.runId, profile: options.profile, sourceCommit: manifest.source.commit, succeeded: true, exitCode: 0, completedAt, error: null, manifestSha256, resultSha256, executionLogSha256, executionLogBytes };
    const completionCoreDigest = sha256Bytes(Buffer.from(JSON.stringify(completionCore)));
    const written = await writeBrainPetPerformanceReceipt({ receiptPath, candidate: gateFile.candidate, gateProfile: options.profile, startedAt: gateFile.startedAt, gateResult: gateFile.gateResult, runEvidence: { runId: options.runId, manifestSha256, resultSha256, executionLogSha256, executionLogBytes, completionCoreDigest } });
    writtenReceiptPath = written.path;
    completion = { schemaVersion: 2, kind: "brainpet-performance-gate-completion", ...completionCore, completionCoreDigest, receiptSha256: written.sha256 };
  } catch (caught) {
    if (caught instanceof BrainPetPerformanceReceiptRollbackError) {
      throw caught;
    }
    if (writtenReceiptPath) {
      try {
        await removePublishedBrainPetPerformanceReceipt(writtenReceiptPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [caught, cleanupError],
          "BrainPet performance execution failed and its published receipt could not be rolled back; preserving the recovery lease.",
        );
      }
    }
    await flushWritable(process.stdout).catch(() => {});
    const executionLogBytes = existsSync(logPath) ? statSync(logPath).size : 0;
    const executionLogSha256 = existsSync(logPath) ? sha256FilePrefix(logPath, executionLogBytes) : sha256Bytes(Buffer.alloc(0));
    const resultSha256 = existsSync(resultPath) ? sha256File(resultPath) : null;
    const completionCore = { runId: options.runId, profile: options.profile, sourceCommit: manifest.source.commit, succeeded: false, exitCode: 1, completedAt: new Date().toISOString(), error: boundedError(caught), manifestSha256, resultSha256, executionLogSha256, executionLogBytes };
    completion = { schemaVersion: 2, kind: "brainpet-performance-gate-completion", ...completionCore, completionCoreDigest: sha256Bytes(Buffer.from(JSON.stringify(completionCore))), receiptSha256: null };
  }
  await finalizePerformancePublication({
    completionPath,
    completion,
    writtenReceiptPath,
    releaseLease: () => releaseOwnedLease(options.runId),
  });
  process.stdout.write(`BRAINPET_GATE_COMPLETION ${JSON.stringify(completion)}\n`);
  process.exitCode = completion.exitCode;
}

export async function finalizePerformancePublication({
  completionPath,
  completion,
  writtenReceiptPath,
  writeCompletion = writeJsonExclusiveAtomic,
  removeReceipt = removePublishedBrainPetPerformanceReceipt,
  releaseLease = () => {},
}) {
  let publicationError = null;
  try {
    await writeCompletion(completionPath, completion);
  } catch (error) {
    publicationError = error;
    if (writtenReceiptPath) {
      try {
        await removeReceipt(writtenReceiptPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "BrainPet completion publication failed and its success receipt could not be rolled back; preserving the recovery lease.",
        );
      }
    }
  }
  try {
    await releaseLease();
  } catch (releaseError) {
    if (publicationError) {
      throw new AggregateError(
        [publicationError, releaseError],
        "BrainPet completion publication failed and its recovery lease could not be released.",
      );
    }
    throw releaseError;
  }
  if (publicationError) throw publicationError;
}

function validateManifest(manifest, manifestPath, expectedLeasePath = leasePath, expectedRunsRoot = runsRoot) {
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.kind, "brainpet-performance-gate-run");
  assertPerformanceProfile(manifest.profile);
  assert.match(manifest.runId ?? "", new RegExp(`^${escapeRegex(manifest.profile)}-[a-f0-9]{40}-\\d{13}-[a-f0-9-]{36}$`, "i"));
  assert.equal(manifest.source?.repository, brainPetDistributionContract.identity.repository);
  assert.match(manifest.source?.commit ?? "", /^[a-f0-9]{40}$/i);
  assert.equal(manifest.source?.treeDirty, false);
  assert.equal(Number.isNaN(Date.parse(manifest.startedAt)), false);
  assert.equal(dirname(resolve(manifestPath)), expectedRunsRoot);
  for (const [key, label] of [["completion", "completion"], ["result", "result"], ["log", "log"], ["preparedCandidateManifest", "prepared candidate manifest"], ["lease", "lease"]]) resolveRepoRelative(manifest[key], `performance ${label}`);
  assert.equal(resolveRepoRelative(manifest.lease, "performance lease"), expectedLeasePath);
  assert.match(manifest.preparedCandidateManifestSha256 ?? "", /^[a-f0-9]{64}$/i);
  assert.equal(manifest.candidate?.releaseMode, "public-release");
  assert.equal(manifest.candidate?.packageTarget, "installer");
  assert.equal(manifest.candidate?.commit, manifest.source.commit);
  assert.equal(manifest.candidate?.preparedManifest, manifest.preparedCandidateManifest);
  assert.equal(manifest.candidate?.preparedManifestSha256, manifest.preparedCandidateManifestSha256);
  assert.ok(Array.isArray(manifest.runner?.commandNeedles) && manifest.runner.commandNeedles.length === 3 && manifest.runner.commandNeedles.every((needle) => typeof needle === "string" && needle.length > 0));
}

function validateCompletionCore(completion, manifest, manifestPath) {
  assert.equal(completion.schemaVersion, 2);
  assert.equal(completion.kind, "brainpet-performance-gate-completion");
  assert.equal(completion.runId, manifest.runId);
  assert.equal(completion.profile, manifest.profile);
  assert.equal(completion.sourceCommit, manifest.source.commit);
  assert.equal(typeof completion.succeeded, "boolean");
  assert.ok(Number.isInteger(completion.exitCode) && completion.exitCode >= 0);
  assert.equal(Number.isNaN(Date.parse(completion.completedAt)), false);
  assert.equal(completion.manifestSha256, sha256File(manifestPath));
  assert.match(completion.executionLogSha256 ?? "", /^[a-f0-9]{64}$/i);
  assert.ok(Number.isInteger(completion.executionLogBytes) && completion.executionLogBytes >= 0);
  const { schemaVersion: _schema, kind: _kind, completionCoreDigest, receiptSha256: _receipt, ...core } = completion;
  assert.equal(completionCoreDigest, sha256Bytes(Buffer.from(JSON.stringify(core))), "BrainPet completion core digest is invalid.");
  if (completion.resultSha256 !== null) assert.match(completion.resultSha256, /^[a-f0-9]{64}$/i);
}

function pickRunEvidence(completion) { return { runId: completion.runId, manifestSha256: completion.manifestSha256, resultSha256: completion.resultSha256, executionLogSha256: completion.executionLogSha256, executionLogBytes: completion.executionLogBytes, completionCoreDigest: completion.completionCoreDigest }; }

function validateGateFile(gateFile, manifest) {
  assert.equal(gateFile.schemaVersion, 1);
  assert.equal(gateFile.kind, "brainpet-performance-gate-result");
  assert.equal(gateFile.runId, manifest.runId);
  assert.equal(gateFile.gateProfile, manifest.profile);
  assert.deepEqual(gateFile.candidate, manifest.candidate, "BrainPet formal result candidate differs from its run manifest.");
  validateBrainPetFormalGateResult(gateFile.gateResult, manifest.profile);
}

async function acquirePerformanceLease(value, paths = defaultPerformancePaths) {
  try { await writeJsonExclusiveAtomic(paths.leasePath, { ...value, revision: 0, phase: "starting", activeChild: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); }
  catch (error) { if (error?.code === "EEXIST") throw new Error("Another BrainPet performance gate acquired the global lease first."); throw error; }
}

export async function updateOwnedPerformanceLease(runId, expectedOwner, patch, paths = defaultPerformancePaths) {
  const current = readJsonRegularFile(paths.leasePath, 64 * 1024, "BrainPet performance lease");
  assert.equal(current.runId, runId, "BrainPet performance lease ownership changed unexpectedly.");
  assert.deepEqual(current.owner, expectedOwner, "BrainPet performance lease writer ownership changed unexpectedly.");
  assert.ok(Number.isInteger(current.revision) && current.revision >= 0, "BrainPet performance lease revision is invalid.");
  await writeJsonReplaceAtomic(paths.leasePath, { ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() });
}

export async function handoffPerformanceLeaseAndPublishManifest({ runId, startingOwner, workerOwner, manifestPath, manifest, paths = defaultPerformancePaths, writeManifest = writeJsonExclusiveAtomic }) {
  await updateOwnedPerformanceLease(runId, startingOwner, { owner: workerOwner, phase: "worker-awaiting-manifest" }, paths);
  await writeManifest(manifestPath, manifest);
}

function releaseOwnedLease(runId) {
  if (!existsSync(leasePath)) return;
  const current = readJsonRegularFile(leasePath, 64 * 1024, "BrainPet performance lease");
  assert.equal(current.runId, runId, "Refusing to release another BrainPet performance run's lease.");
  assert.equal(current.activeChild, null, "Refusing to release a BrainPet performance lease while a child tree may still be active.");
  rmSyncExact(leasePath);
}

function currentProcessIdentity() {
  const identity = queryWindowsProcessIdentity(process.pid);
  assert.ok(identity, "Unable to bind the BrainPet performance lease to the exact startup process identity.");
  return { pid: process.pid, creationDate: identity.creationDate, executable: process.execPath, commandNeedles: [basename(scriptPath), "start"] };
}

function matchesProcessIdentity(identity, expected) { return Boolean(identity && expected && identity.creationDate === expected.creationDate && normalizeWindowsPath(identity.executablePath) === normalizeWindowsPath(expected.executable) && Array.isArray(expected.commandNeedles) && expected.commandNeedles.every((needle) => identity.commandLine.includes(needle))); }

function terminateWindowsProcessTree(activeChild) {
  const identities = [activeChild?.process, activeChild?.wrapper ?? activeChild].filter(Boolean);
  for (const expected of identities) terminateExactWindowsProcessTree(expected);
}

function terminateExactWindowsProcessTree(expected) {
  const script = String.raw`
$expected = $env:BRAINPET_CHILD_IDENTITY | ConvertFrom-Json
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine)
$root = $all | Where-Object { [uint32]$_.ProcessId -eq [uint32]$expected.pid } | Select-Object -First 1
$roots = [System.Collections.Generic.List[object]]::new()
if ($null -ne $root) {
  $same = $root.CreationDate.ToUniversalTime().ToString('o') -eq [string]$expected.creationDate -and
    [string]::Equals([string]$root.ExecutablePath, [string]$expected.executable, [StringComparison]::OrdinalIgnoreCase)
  foreach ($needle in @($expected.commandNeedles)) { if (-not $root.CommandLine -or $root.CommandLine.IndexOf([string]$needle, [StringComparison]::Ordinal) -lt 0) { $same = $false } }
  if (-not $same) { throw 'Refusing to terminate a PID that no longer matches the leased BrainPet child identity.' }
  $roots.Add($root)
} elseif ($null -ne $expected.descendantExpectation) {
  $minimumCreation = [datetime]::Parse([string]$expected.creationDate).ToUniversalTime()
  foreach ($candidate in @($all | Where-Object { [uint32]$_.ParentProcessId -eq [uint32]$expected.pid })) {
    $matches = $candidate.CreationDate.ToUniversalTime() -ge $minimumCreation -and
      [string]::Equals([System.IO.Path]::GetFileName([string]$candidate.ExecutablePath), [string]$expected.descendantExpectation.executableBasename, [StringComparison]::OrdinalIgnoreCase)
    foreach ($needle in @($expected.descendantExpectation.commandNeedles)) { if (-not $candidate.CommandLine -or $candidate.CommandLine.IndexOf([string]$needle, [StringComparison]::Ordinal) -lt 0) { $matches = $false } }
    if ($matches) { $roots.Add($candidate) }
  }
  if ($roots.Count -gt 1) { throw 'Multiple descendants matched a dead BrainPet child wrapper; refusing ambiguous cleanup.' }
}
if ($roots.Count -eq 0) { exit 0 }
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
$depth = @{}
$creation = @{}
foreach ($candidateRoot in $roots) {
  $id = [uint32]$candidateRoot.ProcessId
  [void]$ids.Add($id)
  $depth[$id] = 0
  $creation[$id] = $candidateRoot.CreationDate.ToUniversalTime().ToString('o')
}
for ($round = 0; $round -lt 8; $round++) {
  $snapshot = if ($round -eq 0) { $all } else { @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine) }
  do {
    $changed = $false
    foreach ($process in $snapshot) {
      $parentId = [uint32]$process.ParentProcessId
      $id = [uint32]$process.ProcessId
      if ($ids.Contains($parentId) -and -not $ids.Contains($id) -and $process.CreationDate.ToUniversalTime() -ge [datetime]::Parse([string]$creation[$parentId]).ToUniversalTime()) {
        [void]$ids.Add($id)
        $depth[$id] = [int]$depth[$parentId] + 1
        $creation[$id] = $process.CreationDate.ToUniversalTime().ToString('o')
        $changed = $true
      }
    }
  } while ($changed)
  $targets = @($snapshot | Where-Object { $id = [uint32]$_.ProcessId; $ids.Contains($id) -and $_.CreationDate.ToUniversalTime().ToString('o') -eq [string]$creation[$id] })
  foreach ($process in $targets | Sort-Object { -[int]$depth[[uint32]$_.ProcessId] }) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 100
}
$final = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)
$remaining = @($final | Where-Object {
  $id = [uint32]$_.ProcessId
  $parentId = [uint32]$_.ParentProcessId
  ($ids.Contains($id) -and $_.CreationDate.ToUniversalTime().ToString('o') -eq [string]$creation[$id]) -or
    ($ids.Contains($parentId) -and $_.CreationDate.ToUniversalTime() -ge [datetime]::Parse([string]$creation[$parentId]).ToUniversalTime())
})
if ($remaining.Count -gt 0) { throw 'BrainPet leased child process tree did not reach a quiescent terminated state.' }
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { env: { ...createCleanPerformanceEnvironment(), BRAINPET_CHILD_IDENTITY: JSON.stringify(expected) }, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || "Unable to terminate the leased BrainPet child process tree.");
}

async function writeJsonReplaceAtomic(path, value) {
  const target = resolve(path);
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.replace.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameReplaceAtomicWithRetry(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function renameReplaceAtomicWithRetry(source, target, {
  platform = process.platform,
  renameFile = rename,
  wait = delay,
  maxAttempts = 20,
} = {}) {
  assert.ok(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 100, "Atomic replacement retry count is invalid.");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await renameFile(source, target);
      return;
    } catch (error) {
      const transientWindowsLock = platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
      if (!transientWindowsLock || attempt === maxAttempts) throw error;
      await wait(Math.min(25 * attempt, 250));
    }
  }
}

async function ensureSafeEvidenceDirectory(path) { await mkdir(path, { recursive: true }); assertSafeEvidencePath(path, true); }

function assertSafeEvidencePath(path, mustExist) {
  const requested = resolve(path);
  const child = relative(repoRoot, requested);
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child), "BrainPet evidence path escaped the repository.");
  let current = repoRoot;
  for (const segment of child.split(/[\\/]/)) {
    current = join(current, segment);
    if (!existsSync(current)) { assert.equal(mustExist, false, `BrainPet evidence path is missing: ${current}`); break; }
    assert.equal(lstatSync(current).isSymbolicLink(), false, `BrainPet evidence path contains a symbolic link or junction: ${current}`);
  }
  if (existsSync(requested)) {
    const realChild = relative(realRepoRoot, realpathSync.native(requested));
    assert.ok(realChild && !realChild.startsWith("..") && !isAbsolute(realChild), "BrainPet evidence real path escaped the repository.");
  }
}

function resolveRepoRelative(value, label) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 4096 && !isAbsolute(value), `${label} path is invalid.`);
  const path = resolve(repoRoot, value);
  assertSafeEvidencePath(path, false);
  return path;
}

function toRepoRelative(path) {
  const child = relative(repoRoot, resolve(path));
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child), "BrainPet run path must stay under the repository root.");
  return child.replaceAll("\\", "/");
}

function readJsonRegularFile(path, maximumBytes, label) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximumBytes, `${label} is unsafe or oversized.`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertLogPrefix(path, bytes, digest) {
  assertSafeEvidencePath(path, true);
  assert.ok(statSync(path).size >= bytes, "BrainPet execution log is shorter than its sealed prefix.");
  assert.equal(sha256FilePrefix(path, bytes), digest, "BrainPet execution-log prefix digest is invalid.");
}

function sha256FilePrefix(path, bytes) { return sha256Bytes(readFileSync(path).subarray(0, bytes)); }

function rmSyncExact(path) {
  assertSafeEvidencePath(path, true);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Remove-Item -LiteralPath $env:BRAINPET_EXACT_PATH -Force"], { env: { ...createCleanPerformanceEnvironment(), BRAINPET_EXACT_PATH: resolve(path) }, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || `Unable to remove exact BrainPet evidence path: ${path}`);
}

function runNodeScript(path, environment, runId, leaseOwner) { return runChild(process.execPath, [path], appDir, environment, runId, leaseOwner); }
async function runChild(command, args, cwd, environment, runId, leaseOwner) {
  const supervisorScript = join(scriptDir, "brainpet-windows-job-supervisor.ps1");
  const controlId = `${runId}.${randomUUID()}`;
  const launchPermitPath = join(runsRoot, `.${controlId}.launch.json`);
  const readyPath = join(runsRoot, `.${controlId}.ready.json`);
  const resumePermitPath = join(runsRoot, `.${controlId}.resume.json`);
  const resultPath = join(runsRoot, `.${controlId}.job-result.json`);
  const supervisor = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    supervisorScript,
    "-RunId",
    runId,
    "-LaunchPermitPath",
    launchPermitPath,
    "-ReadyPath",
    readyPath,
    "-ResumePermitPath",
    resumePermitPath,
    "-ResultPath",
    resultPath,
  ], {
    cwd: repoRoot,
    env: { ...createCleanPerformanceEnvironment(), BRAINPET_WRAPPED_CHILD_SPEC: JSON.stringify({ command, args, cwd, environmentEntries: Object.entries(environment).map(([name, value]) => `${name}=${value}`) }) },
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  assert.ok(Number.isInteger(supervisor.pid) && supervisor.pid > 0, "BrainPet Windows Job supervisor lacks a PID.");
  const completion = new Promise((resolvePromise, reject) => {
    supervisor.once("error", reject);
    supervisor.once("exit", (code, signal) => {
      if (signal) reject(new Error(`BrainPet Windows Job supervisor was terminated by ${signal}.`));
      else resolvePromise(code ?? 1);
    });
  });
  let leaseUpdated = false;
  let safeToClear = false;
  let primaryError = null;
  let activeChild = null;
  try {
    const identity = await waitForWindowsProcessIdentity(supervisor.pid, 5_000);
    const supervisorIdentity = {
      pid: supervisor.pid,
      creationDate: identity.creationDate,
      executable: identity.executablePath,
      commandNeedles: [basename(supervisorScript), runId],
    };
    activeChild = { wrapper: supervisorIdentity, process: null };
    await updateOwnedPerformanceLease(runId, leaseOwner, { activeChild, phase: "child-supervisor-ready" });
    leaseUpdated = true;
    await writeJsonExclusiveAtomic(launchPermitPath, { schemaVersion: 1, kind: "brainpet-windows-job-launch-permit", runId });
    await Promise.race([
      waitForPath(readyPath, 30_000),
      completion.then((exitCode) => { throw new Error(`BrainPet Windows Job supervisor exited with code ${exitCode} before publishing its suspended child identity.`); }),
    ]);
    const ready = readJsonRegularFile(readyPath, 16 * 1024, "BrainPet Windows Job ready record");
    assert.deepEqual({ schemaVersion: ready.schemaVersion, kind: ready.kind, runId: ready.runId }, { schemaVersion: 1, kind: "brainpet-windows-job-ready", runId });
    assert.ok(Number.isInteger(ready.pid) && ready.pid > 0, "BrainPet Windows Job ready record lacks its suspended root PID.");
    const childIdentitySnapshot = await waitForWindowsProcessIdentity(ready.pid, 5_000);
    const descendantExpectation = createDescendantExpectation(command, args);
    const childIdentity = { pid: ready.pid, creationDate: childIdentitySnapshot.creationDate, executable: childIdentitySnapshot.executablePath, commandNeedles: descendantExpectation.commandNeedles };
    assert.equal(matchesProcessIdentity(queryWindowsProcessIdentity(childIdentity.pid), childIdentity), true, "BrainPet child process identity did not match the leased command.");
    activeChild = { wrapper: supervisorIdentity, process: childIdentity };
    await updateOwnedPerformanceLease(runId, leaseOwner, { activeChild, phase: "child-running" });
    await writeJsonExclusiveAtomic(resumePermitPath, { schemaVersion: 1, kind: "brainpet-windows-job-resume-permit", runId, pid: ready.pid });
    const supervisorExitCode = await completion;
    await waitForPath(resultPath, 5_000);
    const result = readJsonRegularFile(resultPath, 16 * 1024, "BrainPet Windows Job result");
    validateWindowsJobSupervisorResult(supervisorExitCode, result, { runId, pid: ready.pid });
    safeToClear = true;
    return result.exitCode;
  } catch (error) {
    primaryError = error;
    try { supervisor.kill(); } catch {}
    await completion.catch(() => {});
    try {
      if (activeChild) terminateWindowsProcessTree(activeChild);
      safeToClear = true;
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "BrainPet child wrapper failed and its leased process tree could not be proven terminated.");
    }
    throw error;
  } finally {
    if (leaseUpdated && safeToClear) {
      try {
        await updateOwnedPerformanceLease(runId, leaseOwner, { activeChild: null, phase: "running" });
      } catch (error) {
        if (primaryError) throw new AggregateError([primaryError, error], "BrainPet child failed and its lease could not be cleared.");
        throw error;
      }
    }
    await Promise.all([launchPermitPath, readyPath, resumePermitPath, resultPath].map((path) => rm(path, { force: true }).catch(() => {})));
  }
}

export function validateWindowsJobSupervisorResult(supervisorExitCode, result, expected) {
  assert.deepEqual(
    { schemaVersion: result.schemaVersion, kind: result.kind, runId: result.runId, pid: result.pid },
    { schemaVersion: 1, kind: "brainpet-windows-job-result", runId: expected.runId, pid: expected.pid },
  );
  assert.ok(Number.isInteger(result.exitCode) && result.exitCode >= 0, "BrainPet Windows Job result has an invalid exit code.");
  assert.equal(typeof result.jobQuiescent, "boolean", "BrainPet Windows Job result lacks an exact quiescence outcome.");
  assert.ok(Number.isInteger(result.remainingProcesses) && result.remainingProcesses >= 0, "BrainPet Windows Job result has an invalid remaining-process count.");
  const expectedSupervisorExitCode = result.jobQuiescent && result.exitCode === 0 ? 0 : 1;
  assert.equal(supervisorExitCode, expectedSupervisorExitCode, "BrainPet Windows Job result does not match its supervisor exit status.");
  assert.equal(result.remainingProcesses, 0, "BrainPet wrapped command left background processes in its Windows Job.");
  assert.equal(result.jobQuiescent, true, "BrainPet Windows Job did not attest a quiescent complete process tree.");
}

function createDescendantExpectation(command, args) {
  const commandNeedles = [basename(command), ...args].filter((value) => typeof value === "string" && value.length > 0);
  return { executableBasename: basename(command), commandNeedles };
}

async function waitForWindowsProcessIdentity(pid, timeoutMs) { const startedAt = Date.now(); while (Date.now() - startedAt < timeoutMs) { const identity = queryWindowsProcessIdentity(pid); if (identity) return identity; await delay(100); } throw new Error(`Timed out resolving detached BrainPet gate worker PID ${pid}.`); }
async function waitForPath(path, timeoutMs) { const startedAt = Date.now(); while (Date.now() - startedAt < timeoutMs) { if (existsSync(path)) return; await delay(100); } throw new Error(`Timed out waiting for BrainPet run manifest: ${path}`); }
function flushWritable(stream) { return new Promise((resolvePromise, reject) => stream.write("", (error) => error ? reject(error) : resolvePromise())); }
function boundedError(error) { const value = error instanceof Error ? error.message : String(error); return value.slice(0, 4096) || "Unknown BrainPet performance failure."; }

function parseOptions(argv) {
  const command = argv[0];
  const options = { command, profile: null, runId: null, manifest: null, completion: null, candidate: null };
  if ((command === "start" || command === "status") && argv[1] && !argv[1].startsWith("--")) options.profile = argv[1];
  for (let index = command === "worker" ? 1 : 2; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--profile") options.profile = value;
    else if (argv[index] === "--run-id") options.runId = value;
    else if (argv[index] === "--manifest") options.manifest = value;
    else if (argv[index] === "--completion") options.completion = value;
    else if (argv[index] === "--candidate") options.candidate = value;
    else throw new Error(`Unknown BrainPet performance runner argument: ${argv[index]}`);
    index += 1;
  }
  return options;
}

async function main(argv) {
  const options = parseOptions(argv);
  if (options.command === "start") { const started = await startBrainPetPerformanceGate(options.profile, options.candidate); process.stdout.write(`${JSON.stringify({ state: "started", manifestPath: started.manifestPath, manifest: started.manifest })}\n`); }
  else if (options.command === "status") { assertPerformanceProfile(options.profile); const [manifestPath] = listBrainPetPerformanceRunManifests(options.profile); assert.ok(manifestPath, `No BrainPet ${options.profile} run manifest exists.`); process.stdout.write(`${JSON.stringify(readBrainPetPerformanceGateStatus(manifestPath))}\n`); }
  else if (options.command === "worker") { assert.ok(options.profile && options.runId && options.manifest && options.completion, "BrainPet gate worker arguments are incomplete."); await runWorker(options); }
  else throw new Error("Usage: brainpet-performance-gate-runner.mjs start <active-30m|idle-24h> --candidate <prepared-manifest> | status <profile>");
}

function assertPerformanceProfile(profile) { assert.equal(typeof profile === "string" && Object.hasOwn(profiles, profile), true, `Unknown BrainPet performance profile: ${profile}`); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function normalizeWindowsPath(value) { return typeof value === "string" ? resolve(value).toLowerCase() : ""; }
function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
}
