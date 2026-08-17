#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { cp, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "../../../scripts/brainpet-release-contract.mjs";
import { validateBrainPetFormalGateResult } from "./brainpet-performance-contract.mjs";
import {
  assertBrainPetPerformanceReceiptAvailable,
  revalidateBrainPetPerformanceCandidate,
  resolveBrainPetPerformanceReceiptPath,
  resolveTrackedGitIdentity,
  sha256Bytes,
  sha256File,
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
const profiles = Object.freeze({
  "active-30m": Object.freeze({ soakMs: "1800000", task: "cargo-signal" }),
  "idle-24h": Object.freeze({ idleSoakMs: "86400000" }),
});

export async function startBrainPetPerformanceGate(profile) {
  assert.equal(process.platform, "win32", "The detached BrainPet performance runner currently requires Windows.");
  assertPerformanceProfile(profile);
  const source = resolveTrackedGitIdentity(repoRoot);
  assert.equal(source.treeDirty, false, "A formal BrainPet performance run requires a clean tracked worktree.");
  await ensureSafeEvidenceDirectory(runsRoot);
  const runId = `${profile}-${source.commit}-${Date.now()}-${randomUUID()}`;
  const manifestPath = join(runsRoot, `${runId}.manifest.json`);
  const completionPath = join(runsRoot, `${runId}.completion.json`);
  const resultPath = join(runsRoot, `${runId}.result.json`);
  const logPath = join(runsRoot, `${runId}.log`);
  const stagingRoot = join(runsRoot, `${runId}.candidate`);
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
      schemaVersion: 2,
      kind: "brainpet-performance-gate-run",
      runId,
      profile,
      source,
      startedAt: new Date().toISOString(),
      expectedReceipt: toRepoRelative(expectedReceiptPath),
      result: toRepoRelative(resultPath),
      log: toRepoRelative(logPath),
      completion: toRepoRelative(completionPath),
      stagingRoot: toRepoRelative(stagingRoot),
      lease: toRepoRelative(leasePath),
      runner: {
        pid: child.pid,
        creationDate: runnerIdentity.creationDate,
        executable: process.execPath,
        commandNeedles: [basename(scriptPath), "worker", runId],
      },
    };
    await writeJsonExclusiveAtomic(manifestPath, manifest);
    await updateOwnedLease(runId, { owner: manifest.runner, phase: "running" });
    child.unref();
    return { manifestPath, manifest };
  } catch (error) {
    child?.kill();
    await Promise.all([manifestPath, completionPath, resultPath, logPath, stagingRoot].map((path) => rm(path, { recursive: true, force: true }).catch(() => {})));
    releaseOwnedLease(runId);
    throw error;
  } finally {
    if (logDescriptor !== null) closeSync(logDescriptor);
  }
}

export function readBrainPetPerformanceGateStatus(manifestPath, queryProcessIdentity = queryWindowsProcessIdentity) {
  assertSafeEvidencePath(manifestPath, true);
  const resolvedManifestPath = resolve(manifestPath);
  const manifest = readJsonRegularFile(resolvedManifestPath, 128 * 1024, "BrainPet performance run manifest");
  validateManifest(manifest, resolvedManifestPath);
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
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "PNPM_HOME"];
  const environment = {};
  for (const key of allowed) if (typeof process.env[key] === "string") environment[key] = process.env[key];
  return { ...environment, ...overrides };
}

export function recoverOrRejectPerformanceLease(queryProcessIdentity = queryWindowsProcessIdentity, terminateProcessTree = terminateWindowsProcessTree) {
  if (!existsSync(leasePath)) return false;
  assertSafeEvidencePath(leasePath, true);
  const lease = readJsonRegularFile(leasePath, 64 * 1024, "BrainPet performance lease");
  if (lease.manifest) {
    const manifestPath = resolveRepoRelative(lease.manifest, "performance lease manifest");
    if (existsSync(manifestPath)) {
      const status = readBrainPetPerformanceGateStatus(manifestPath, queryProcessIdentity);
      assert.notEqual(status.state, "running", `BrainPet ${status.manifest.profile} is already running as PID ${status.manifest.runner.pid}.`);
      if (status.state === "interrupted" && status.receiptPath) rmSyncExact(status.receiptPath);
    } else if (matchesProcessIdentity(queryProcessIdentity(lease.owner?.pid), lease.owner)) {
      throw new Error(`BrainPet performance gate startup is already owned by PID ${lease.owner.pid}.`);
    }
  } else if (matchesProcessIdentity(queryProcessIdentity(lease.owner?.pid), lease.owner)) {
    throw new Error(`BrainPet performance gate startup is already owned by PID ${lease.owner.pid}.`);
  }
  if (lease.activeChild && matchesProcessIdentity(queryProcessIdentity(lease.activeChild.pid), lease.activeChild)) terminateProcessTree(lease.activeChild);
  rmSyncExact(leasePath);
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
  const stagingRoot = resolveRepoRelative(manifest.stagingRoot, "performance candidate staging root");
  const receiptPath = resolveRepoRelative(manifest.expectedReceipt, "expected performance receipt");
  const manifestSha256 = sha256File(manifestPath);
  let completion;
  let writtenReceiptPath = null;
  try {
    const packageExit = await runPnpmDesktopScript("package:brainpet:unpacked", createCleanPerformanceEnvironment(), options.runId);
    if (packageExit !== 0) throw new Error(`BrainPet package command exited with code ${packageExit}.`);
    const sourceRoot = join(appDir, "dist-brainpet", "private-test");
    assert.equal(existsSync(stagingRoot), false, "BrainPet per-run candidate staging root already exists.");
    await cp(sourceRoot, stagingRoot, { recursive: true, force: false, errorOnExist: true });
    const stagedExecutable = join(stagingRoot, "win-unpacked", "brainpet.exe");
    const stagedReceipt = join(stagingRoot, "brainpet-package-receipt-windows-x64.json");
    const smokeEnvironment = createCleanPerformanceEnvironment({
      BRAINPET_GATE_RUN_ID: options.runId,
      BRAINPET_GATE_RESULT_PATH: resultPath,
      BRAINPET_PERFORMANCE_GATE: options.profile,
      BRAINPET_ENFORCE_RESOURCE_BUDGET: "1",
      BRAINPET_ELECTRON_EXECUTABLE: stagedExecutable,
      BRAINPET_PACKAGE_RECEIPT: stagedReceipt,
      ...(options.profile === "active-30m" ? { BRAINPET_SOAK_MS: profiles[options.profile].soakMs, BRAINPET_PERFORMANCE_EXECUTABLE: stagedExecutable, BRAINPET_SMOKE_TASK: profiles[options.profile].task } : { BRAINPET_IDLE_SOAK_MS: profiles[options.profile].idleSoakMs }),
    });
    const smokeExit = await runNodeScript(join(scriptDir, "brainpet-electron-smoke.mjs"), smokeEnvironment, options.runId);
    if (smokeExit !== 0) throw new Error(`BrainPet ${options.profile} command exited with code ${smokeExit}.`);
    const gateFile = readJsonRegularFile(resultPath, 16 * 1024 * 1024, "BrainPet formal gate result");
    assert.equal(gateFile.schemaVersion, 1);
    assert.equal(gateFile.kind, "brainpet-performance-gate-result");
    assert.equal(gateFile.runId, options.runId);
    assert.equal(gateFile.gateProfile, options.profile);
    assert.equal(gateFile.candidate.commit, manifest.source.commit);
    validateBrainPetFormalGateResult(gateFile.gateResult, options.profile);
    revalidateBrainPetPerformanceCandidate(gateFile.candidate, { repoRoot });
    const resultSha256 = sha256File(resultPath);
    await flushWritable(process.stdout);
    const executionLogBytes = statSync(logPath).size;
    const executionLogSha256 = sha256FilePrefix(logPath, executionLogBytes);
    const completedAt = new Date().toISOString();
    const completionCore = { runId: options.runId, profile: options.profile, sourceCommit: manifest.source.commit, succeeded: true, exitCode: 0, completedAt, error: null, manifestSha256, resultSha256, executionLogSha256, executionLogBytes };
    const completionCoreDigest = sha256Bytes(Buffer.from(JSON.stringify(completionCore)));
    await rm(stagingRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const written = await writeBrainPetPerformanceReceipt({ receiptPath, candidate: gateFile.candidate, gateProfile: options.profile, startedAt: gateFile.startedAt, gateResult: gateFile.gateResult, runEvidence: { runId: options.runId, manifestSha256, resultSha256, executionLogSha256, executionLogBytes, completionCoreDigest } });
    writtenReceiptPath = written.path;
    completion = { schemaVersion: 2, kind: "brainpet-performance-gate-completion", ...completionCore, completionCoreDigest, receiptSha256: written.sha256 };
  } catch (caught) {
    if (writtenReceiptPath) await rm(writtenReceiptPath, { force: true }).catch(() => {});
    await rm(stagingRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    await flushWritable(process.stdout).catch(() => {});
    const executionLogBytes = existsSync(logPath) ? statSync(logPath).size : 0;
    const executionLogSha256 = existsSync(logPath) ? sha256FilePrefix(logPath, executionLogBytes) : sha256Bytes(Buffer.alloc(0));
    const resultSha256 = existsSync(resultPath) ? sha256File(resultPath) : null;
    const completionCore = { runId: options.runId, profile: options.profile, sourceCommit: manifest.source.commit, succeeded: false, exitCode: 1, completedAt: new Date().toISOString(), error: boundedError(caught), manifestSha256, resultSha256, executionLogSha256, executionLogBytes };
    completion = { schemaVersion: 2, kind: "brainpet-performance-gate-completion", ...completionCore, completionCoreDigest: sha256Bytes(Buffer.from(JSON.stringify(completionCore))), receiptSha256: null };
  }
  try {
    await writeJsonExclusiveAtomic(completionPath, completion);
  } finally {
    releaseOwnedLease(options.runId);
  }
  process.stdout.write(`BRAINPET_GATE_COMPLETION ${JSON.stringify(completion)}\n`);
  process.exitCode = completion.exitCode;
}

function validateManifest(manifest, manifestPath) {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.kind, "brainpet-performance-gate-run");
  assertPerformanceProfile(manifest.profile);
  assert.match(manifest.runId ?? "", new RegExp(`^${escapeRegex(manifest.profile)}-[a-f0-9]{40}-\\d{13}-[a-f0-9-]{36}$`, "i"));
  assert.equal(manifest.source?.repository, brainPetDistributionContract.identity.repository);
  assert.match(manifest.source?.commit ?? "", /^[a-f0-9]{40}$/i);
  assert.equal(manifest.source?.treeDirty, false);
  assert.equal(Number.isNaN(Date.parse(manifest.startedAt)), false);
  assert.equal(dirname(resolve(manifestPath)), runsRoot);
  for (const [key, label] of [["completion", "completion"], ["result", "result"], ["log", "log"], ["stagingRoot", "staging"], ["lease", "lease"]]) resolveRepoRelative(manifest[key], `performance ${label}`);
  assert.equal(resolveRepoRelative(manifest.lease, "performance lease"), leasePath);
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
  assert.equal(gateFile.candidate?.commit, manifest.source.commit);
  validateBrainPetFormalGateResult(gateFile.gateResult, manifest.profile);
}

async function acquirePerformanceLease(value) {
  try { await writeJsonExclusiveAtomic(leasePath, { ...value, phase: "starting", activeChild: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); }
  catch (error) { if (error?.code === "EEXIST") throw new Error("Another BrainPet performance gate acquired the global lease first."); throw error; }
}

async function updateOwnedLease(runId, patch) {
  const current = readJsonRegularFile(leasePath, 64 * 1024, "BrainPet performance lease");
  assert.equal(current.runId, runId, "BrainPet performance lease ownership changed unexpectedly.");
  await writeJsonReplaceAtomic(leasePath, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

function releaseOwnedLease(runId) {
  if (!existsSync(leasePath)) return;
  const current = readJsonRegularFile(leasePath, 64 * 1024, "BrainPet performance lease");
  assert.equal(current.runId, runId, "Refusing to release another BrainPet performance run's lease.");
  rmSyncExact(leasePath);
}

function currentProcessIdentity() {
  const identity = queryWindowsProcessIdentity(process.pid);
  assert.ok(identity, "Unable to bind the BrainPet performance lease to the exact startup process identity.");
  return { pid: process.pid, creationDate: identity.creationDate, executable: process.execPath, commandNeedles: [basename(scriptPath), "start"] };
}

function matchesProcessIdentity(identity, expected) { return Boolean(identity && expected && identity.creationDate === expected.creationDate && normalizeWindowsPath(identity.executablePath) === normalizeWindowsPath(expected.executable) && Array.isArray(expected.commandNeedles) && expected.commandNeedles.every((needle) => identity.commandLine.includes(needle))); }

function terminateWindowsProcessTree(expected) {
  const script = String.raw`
$expected = $env:BRAINPET_CHILD_IDENTITY | ConvertFrom-Json
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine)
$root = $all | Where-Object { [uint32]$_.ProcessId -eq [uint32]$expected.pid } | Select-Object -First 1
if ($null -eq $root) { exit 0 }
$same = $root.CreationDate.ToUniversalTime().ToString('o') -eq [string]$expected.creationDate -and
  [string]::Equals([string]$root.ExecutablePath, [string]$expected.executable, [StringComparison]::OrdinalIgnoreCase)
foreach ($needle in @($expected.commandNeedles)) { if (-not $root.CommandLine -or $root.CommandLine.IndexOf([string]$needle, [StringComparison]::Ordinal) -lt 0) { $same = $false } }
if (-not $same) { throw 'Refusing to terminate a PID that no longer matches the leased BrainPet child identity.' }
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
[void]$ids.Add([uint32]$root.ProcessId)
do {
  $changed = $false
  foreach ($process in $all) { if ($ids.Contains([uint32]$process.ParentProcessId) -and $ids.Add([uint32]$process.ProcessId)) { $changed = $true } }
} while ($changed)
foreach ($id in @($ids) | Sort-Object -Descending) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 300
$remaining = Get-CimInstance Win32_Process -Filter "ProcessId = $($expected.pid)" | Select-Object -First 1
if ($null -ne $remaining -and $remaining.CreationDate.ToUniversalTime().ToString('o') -eq [string]$expected.creationDate) { throw 'BrainPet leased child process tree did not terminate.' }
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
    await rename(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
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

function runPnpmDesktopScript(scriptName, environment, runId) { return runChild("cmd.exe", ["/d", "/s", "/c", "pnpm.cmd", "--filter", "@open-pets/desktop", scriptName], repoRoot, environment, runId); }
function runNodeScript(path, environment, runId) { return runChild(process.execPath, [path], appDir, environment, runId); }
async function runChild(command, args, cwd, environment, runId) {
  const wrapper = spawn(process.execPath, [scriptPath, "child", "--run-id", runId], {
    cwd: repoRoot,
    env: { ...createCleanPerformanceEnvironment(), BRAINPET_WRAPPED_CHILD_SPEC: JSON.stringify({ command, args, cwd, environment }) },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    windowsHide: true,
  });
  assert.ok(Number.isInteger(wrapper.pid) && wrapper.pid > 0, "BrainPet leased child wrapper lacks a PID.");
  const completion = new Promise((resolvePromise, reject) => {
    wrapper.once("error", reject);
    wrapper.once("exit", (code, signal) => signal ? reject(new Error(`BrainPet child wrapper was terminated by ${signal}.`)) : resolvePromise(code ?? 1));
  });
  let leaseUpdated = false;
  let primaryError = null;
  try {
    const identity = await waitForWindowsProcessIdentity(wrapper.pid, 5_000);
    const activeChild = { pid: wrapper.pid, creationDate: identity.creationDate, executable: process.execPath, commandNeedles: [basename(scriptPath), "child", runId] };
    await updateOwnedLease(runId, { activeChild, phase: "child-running" });
    leaseUpdated = true;
    wrapper.send({ command: "start" });
    return await completion;
  } catch (error) {
    primaryError = error;
    try { wrapper.kill(); } catch {}
    await completion.catch(() => {});
    throw error;
  } finally {
    if (leaseUpdated) {
      try {
        await updateOwnedLease(runId, { activeChild: null, phase: "running" });
      } catch (error) {
        if (primaryError) throw new AggregateError([primaryError, error], "BrainPet child failed and its lease could not be cleared.");
        throw error;
      }
    }
  }
}

async function runWrappedChild(options) {
  assert.match(options.runId ?? "", /^(?:active-30m|idle-24h)-[a-f0-9]{40}-\d{13}-[a-f0-9-]{36}$/i);
  const spec = JSON.parse(process.env.BRAINPET_WRAPPED_CHILD_SPEC ?? "null");
  assert.ok(spec && typeof spec.command === "string" && Array.isArray(spec.args) && typeof spec.cwd === "string" && spec.environment && typeof spec.environment === "object", "BrainPet wrapped child specification is invalid.");
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the BrainPet child lease permit.")), 10_000);
    process.once("disconnect", () => { clearTimeout(timer); reject(new Error("BrainPet worker disconnected before permitting its leased child.")); });
    process.once("message", (message) => {
      if (message?.command !== "start") return;
      clearTimeout(timer);
      resolvePromise();
    });
  });
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.environment, stdio: "inherit", windowsHide: true });
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`BrainPet wrapped child was terminated by ${signal}.`)) : resolvePromise(code ?? 1));
  });
  process.exitCode = exitCode;
}

async function waitForWindowsProcessIdentity(pid, timeoutMs) { const startedAt = Date.now(); while (Date.now() - startedAt < timeoutMs) { const identity = queryWindowsProcessIdentity(pid); if (identity) return identity; await delay(100); } throw new Error(`Timed out resolving detached BrainPet gate worker PID ${pid}.`); }
async function waitForPath(path, timeoutMs) { const startedAt = Date.now(); while (Date.now() - startedAt < timeoutMs) { if (existsSync(path)) return; await delay(100); } throw new Error(`Timed out waiting for BrainPet run manifest: ${path}`); }
function flushWritable(stream) { return new Promise((resolvePromise, reject) => stream.write("", (error) => error ? reject(error) : resolvePromise())); }
function boundedError(error) { const value = error instanceof Error ? error.message : String(error); return value.slice(0, 4096) || "Unknown BrainPet performance failure."; }

function parseOptions(argv) {
  const command = argv[0];
  const options = { command, profile: null, runId: null, manifest: null, completion: null };
  if ((command === "start" || command === "status") && argv[1] && !argv[1].startsWith("--")) options.profile = argv[1];
  for (let index = command === "worker" || command === "child" ? 1 : 2; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--profile") options.profile = value;
    else if (argv[index] === "--run-id") options.runId = value;
    else if (argv[index] === "--manifest") options.manifest = value;
    else if (argv[index] === "--completion") options.completion = value;
    else throw new Error(`Unknown BrainPet performance runner argument: ${argv[index]}`);
    index += 1;
  }
  return options;
}

async function main(argv) {
  const options = parseOptions(argv);
  if (options.command === "start") { const started = await startBrainPetPerformanceGate(options.profile); process.stdout.write(`${JSON.stringify({ state: "started", manifestPath: started.manifestPath, manifest: started.manifest })}\n`); }
  else if (options.command === "status") { assertPerformanceProfile(options.profile); const [manifestPath] = listBrainPetPerformanceRunManifests(options.profile); assert.ok(manifestPath, `No BrainPet ${options.profile} run manifest exists.`); process.stdout.write(`${JSON.stringify(readBrainPetPerformanceGateStatus(manifestPath))}\n`); }
  else if (options.command === "worker") { assert.ok(options.profile && options.runId && options.manifest && options.completion, "BrainPet gate worker arguments are incomplete."); await runWorker(options); }
  else if (options.command === "child") { assert.ok(options.runId, "BrainPet child wrapper run id is missing."); await runWrappedChild(options); }
  else throw new Error("Usage: brainpet-performance-gate-runner.mjs <start|status> <active-30m|idle-24h>");
}

function assertPerformanceProfile(profile) { assert.equal(typeof profile === "string" && Object.hasOwn(profiles, profile), true, `Unknown BrainPet performance profile: ${profile}`); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function normalizeWindowsPath(value) { return typeof value === "string" ? resolve(value).toLowerCase() : ""; }
function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
}
