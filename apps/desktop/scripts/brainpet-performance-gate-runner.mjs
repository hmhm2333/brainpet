#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "../../../scripts/brainpet-release-contract.mjs";
import {
  assertBrainPetPerformanceReceiptAvailable,
  resolveBrainPetPerformanceReceiptPath,
  resolveTrackedGitIdentity,
  validateBrainPetPerformanceReceipt,
  writeJsonExclusiveAtomic,
} from "./brainpet-performance-receipt.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const appDir = resolve(scriptDir, "..");
const repoRoot = resolve(appDir, "..", "..");
const performanceRoot = join(repoRoot, "output", "performance");
const runsRoot = join(performanceRoot, "runs");
const profileScripts = Object.freeze({
  "active-30m": "test:brainpet-soak",
  "idle-24h": "test:brainpet-idle-soak",
});

export async function startBrainPetPerformanceGate(profile) {
  assert.equal(process.platform, "win32", "The detached BrainPet performance runner currently requires Windows.");
  assertPerformanceProfile(profile);
  const source = resolveTrackedGitIdentity(repoRoot);
  assert.equal(source.treeDirty, false, "A formal BrainPet performance run requires a clean tracked worktree.");
  await mkdir(runsRoot, { recursive: true });

  for (const manifestPath of listBrainPetPerformanceRunManifests(profile)) {
    const status = readBrainPetPerformanceGateStatus(manifestPath);
    assert.notEqual(status.state, "running", `BrainPet ${profile} is already running as PID ${status.manifest.runner.pid}.`);
  }

  const expectedReceiptPath = resolveBrainPetPerformanceReceiptPath(source, profile, performanceRoot);
  assertBrainPetPerformanceReceiptAvailable(expectedReceiptPath);
  const runId = `${profile}-${source.commit}-${Date.now()}-${randomUUID()}`;
  const manifestPath = join(runsRoot, `${runId}.json`);
  const completionPath = join(runsRoot, `${runId}.completion.json`);
  const logPath = join(runsRoot, `${runId}.log`);
  const logDescriptor = openSync(logPath, "wx", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [scriptPath, "worker", "--profile", profile, "--run-id", runId, "--manifest", manifestPath, "--completion", completionPath], {
      cwd: repoRoot,
      detached: true,
      env: { ...process.env, BRAINPET_GATE_RUN_ID: runId },
      stdio: ["ignore", logDescriptor, logDescriptor],
      windowsHide: true,
    });
    assert.ok(Number.isInteger(child.pid) && child.pid > 0, "Detached BrainPet gate worker lacks a PID.");
    const runnerIdentity = await waitForWindowsProcessIdentity(child.pid, 5_000);
    const manifest = {
      schemaVersion: 1,
      kind: "brainpet-performance-gate-run",
      runId,
      profile,
      source,
      startedAt: new Date().toISOString(),
      expectedReceipt: toRepoRelative(expectedReceiptPath),
      log: toRepoRelative(logPath),
      completion: toRepoRelative(completionPath),
      runner: {
        pid: child.pid,
        creationDate: runnerIdentity.creationDate,
        executable: process.execPath,
        commandNeedles: [basename(scriptPath), "worker", runId],
      },
    };
    await writeJsonExclusiveAtomic(manifestPath, manifest);
    child.unref();
    return { manifestPath, manifest };
  } catch (error) {
    child?.kill();
    await rm(manifestPath, { force: true }).catch(() => {});
    await rm(completionPath, { force: true }).catch(() => {});
    await rm(logPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    closeSync(logDescriptor);
  }
}

export function readBrainPetPerformanceGateStatus(manifestPath, queryProcessIdentity = queryWindowsProcessIdentity) {
  const resolvedManifestPath = resolve(manifestPath);
  const manifest = readJsonRegularFile(resolvedManifestPath, 64 * 1024, "BrainPet performance run manifest");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, "brainpet-performance-gate-run");
  assertPerformanceProfile(manifest.profile);
  assert.match(manifest.runId ?? "", new RegExp(`^${escapeRegex(manifest.profile)}-[a-f0-9]{40}-\\d{13}-[a-f0-9-]{36}$`, "i"));
  assert.match(manifest.source?.commit ?? "", /^[a-f0-9]{40}$/i);
  assert.equal(manifest.source?.repository, brainPetDistributionContract.identity.repository);
  assert.equal(manifest.source?.treeDirty, false, "BrainPet performance run manifest came from a dirty tracked tree.");
  assert.equal(Number.isNaN(Date.parse(manifest.startedAt)), false, "BrainPet performance run manifest has an invalid start time.");
  const expectedReceiptPath = resolveRepoRelative(manifest.expectedReceipt, "expected performance receipt");
  const completionPath = resolveRepoRelative(manifest.completion, "performance completion record");
  const logPath = resolveRepoRelative(manifest.log, "performance run log");
  assert.equal(dirname(resolvedManifestPath), runsRoot, "BrainPet performance manifest must stay in the run directory.");
  assert.equal(dirname(completionPath), runsRoot, "BrainPet performance completion record must stay in the run directory.");
  assert.equal(dirname(logPath), runsRoot, "BrainPet performance log must stay in the run directory.");
  assert.equal(expectedReceiptPath, resolveBrainPetPerformanceReceiptPath(manifest.source, manifest.profile, performanceRoot), "BrainPet performance manifest expects the wrong receipt path.");

  if (existsSync(completionPath)) {
    const completion = readJsonRegularFile(completionPath, 64 * 1024, "BrainPet performance completion record");
    assert.equal(completion.schemaVersion, 1);
    assert.equal(completion.kind, "brainpet-performance-gate-completion");
    assert.equal(completion.runId, manifest.runId);
    assert.equal(completion.profile, manifest.profile);
    assert.equal(completion.sourceCommit, manifest.source.commit);
    assert.equal(typeof completion.succeeded, "boolean");
    assert.equal(Number.isInteger(completion.exitCode) && completion.exitCode >= 0, true);
    assert.equal(Number.isNaN(Date.parse(completion.completedAt)), false);
    if (completion.succeeded === true) {
      assert.equal(completion.exitCode, 0);
      assert.equal(completion.error, null);
      const performanceReceipt = validateBrainPetPerformanceReceipt(expectedReceiptPath, { gateProfile: manifest.profile });
      assert.equal(performanceReceipt.candidate.commit, manifest.source.commit, "BrainPet performance receipt source commit does not match its run manifest.");
      return { state: "passed", manifestPath: resolvedManifestPath, manifest, completion, receiptPath: expectedReceiptPath, logPath };
    }
    assert.notEqual(completion.exitCode, 0);
    assert.ok(typeof completion.error === "string" && completion.error.length > 0 && completion.error.length <= 4096, "Failed BrainPet performance completion lacks a bounded error.");
    return { state: "failed", manifestPath: resolvedManifestPath, manifest, completion, receiptPath: existsSync(expectedReceiptPath) ? expectedReceiptPath : null, logPath };
  }

  const identity = queryProcessIdentity(manifest.runner?.pid);
  assert.ok(Array.isArray(manifest.runner?.commandNeedles) && manifest.runner.commandNeedles.length === 3 && manifest.runner.commandNeedles.every((needle) => typeof needle === "string" && needle.length > 0), "BrainPet performance runner command binding is invalid.");
  const exactRunner = identity
    && identity.creationDate === manifest.runner?.creationDate
    && normalizeWindowsPath(identity.executablePath) === normalizeWindowsPath(manifest.runner?.executable)
    && manifest.runner.commandNeedles.every((needle) => identity.commandLine.includes(needle));
  return {
    state: exactRunner ? "running" : "interrupted",
    manifestPath: resolvedManifestPath,
    manifest,
    completion: null,
    receiptPath: existsSync(expectedReceiptPath) ? expectedReceiptPath : null,
    logPath,
    runnerIdentity: identity,
  };
}

export function listBrainPetPerformanceRunManifests(profile) {
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json") && !entry.name.endsWith(".completion.json"))
    .map((entry) => join(runsRoot, entry.name))
    .filter((path) => {
      if (!profile) return true;
      try {
        return JSON.parse(readFileSync(path, "utf8")).profile === profile;
      } catch {
        return true;
      }
    })
    .sort((left, right) => lstatSync(right).mtimeMs - lstatSync(left).mtimeMs);
}

export function queryWindowsProcessIdentity(pid) {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return null;
  const script = String.raw`
$processId = [uint32]$env:BRAINPET_RUNNER_PID
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" | Select-Object -First 1
if ($null -eq $process) { exit 3 }
[pscustomobject]@{
  processId = [uint32]$process.ProcessId
  creationDate = $process.CreationDate.ToUniversalTime().ToString('o')
  executablePath = [string]$process.ExecutablePath
  commandLine = [string]$process.CommandLine
} | ConvertTo-Json -Compress
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { ...process.env, BRAINPET_RUNNER_PID: String(pid) },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  try {
    const identity = JSON.parse(result.stdout.trim());
    return Number(identity.processId) === pid && typeof identity.creationDate === "string" && typeof identity.executablePath === "string" && typeof identity.commandLine === "string" ? identity : null;
  } catch {
    return null;
  }
}

async function runWorker(options) {
  assert.equal(process.platform, "win32", "The BrainPet performance worker currently requires Windows.");
  assertPerformanceProfile(options.profile);
  assert.equal(process.env.BRAINPET_GATE_RUN_ID, options.runId, "BrainPet gate worker run identity is missing.");
  const manifestPath = resolve(options.manifest);
  const completionPath = resolve(options.completion);
  await waitForPath(manifestPath, 30_000);
  const manifest = readJsonRegularFile(manifestPath, 64 * 1024, "BrainPet performance run manifest");
  assert.equal(manifest.runId, options.runId);
  assert.equal(manifest.profile, options.profile);
  process.stdout.write(`BRAINPET_GATE_WORKER ${JSON.stringify({ runId: options.runId, profile: options.profile, pid: process.pid, startedAt: new Date().toISOString() })}\n`);

  let exitCode = 1;
  let error = null;
  try {
    exitCode = await runPnpmDesktopScript(profileScripts[options.profile]);
    if (exitCode !== 0) throw new Error(`BrainPet ${options.profile} command exited with code ${exitCode}.`);
    const receiptPath = resolveRepoRelative(manifest.expectedReceipt, "expected performance receipt");
    const performanceReceipt = validateBrainPetPerformanceReceipt(receiptPath, { gateProfile: options.profile });
    assert.equal(performanceReceipt.candidate.commit, manifest.source.commit, "BrainPet performance receipt source commit does not match its run manifest.");
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    if (exitCode === 0) exitCode = 1;
  }
  const completion = {
    schemaVersion: 1,
    kind: "brainpet-performance-gate-completion",
    runId: options.runId,
    profile: options.profile,
    sourceCommit: manifest.source.commit,
    succeeded: exitCode === 0,
    exitCode,
    completedAt: new Date().toISOString(),
    error,
  };
  await writeJsonExclusiveAtomic(completionPath, completion);
  process.stdout.write(`BRAINPET_GATE_COMPLETION ${JSON.stringify(completion)}\n`);
  process.exitCode = exitCode;
}

function runPnpmDesktopScript(scriptName) {
  const command = process.platform === "win32" ? "cmd.exe" : "pnpm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "pnpm.cmd", "--filter", "@open-pets/desktop", scriptName]
    : ["--filter", "@open-pets/desktop", scriptName];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env: process.env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`BrainPet ${scriptName} was terminated by ${signal}.`)) : resolvePromise(code ?? 1));
  });
}

async function waitForWindowsProcessIdentity(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const identity = queryWindowsProcessIdentity(pid);
    if (identity) return identity;
    await delay(100);
  }
  throw new Error(`Timed out resolving detached BrainPet gate worker PID ${pid}.`);
}

async function waitForPath(path, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for BrainPet run manifest: ${path}`);
}

function readJsonRegularFile(path, maximumBytes, label) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximumBytes, `${label} is unsafe or oversized.`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveRepoRelative(value, label) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 4096 && !isAbsolute(value), `${label} path is invalid.`);
  const path = resolve(repoRoot, value);
  const child = relative(repoRoot, path);
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child), `${label} must stay under the repository root.`);
  return path;
}

function toRepoRelative(path) {
  const child = relative(repoRoot, resolve(path));
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child), "BrainPet run path must stay under the repository root.");
  return child.replaceAll("\\", "/");
}

function parseOptions(argv) {
  const command = argv[0];
  const options = { command, profile: null, runId: null, manifest: null, completion: null };
  if ((command === "start" || command === "status") && argv[1] && !argv[1].startsWith("--")) options.profile = argv[1];
  for (let index = command === "worker" ? 1 : 2; index < argv.length; index += 1) {
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
  if (options.command === "start") {
    const started = await startBrainPetPerformanceGate(options.profile);
    process.stdout.write(`${JSON.stringify({ state: "started", manifestPath: started.manifestPath, manifest: started.manifest })}\n`);
    return;
  }
  if (options.command === "status") {
    assertPerformanceProfile(options.profile);
    const [manifestPath] = listBrainPetPerformanceRunManifests(options.profile);
    assert.ok(manifestPath, `No BrainPet ${options.profile} run manifest exists.`);
    process.stdout.write(`${JSON.stringify(readBrainPetPerformanceGateStatus(manifestPath))}\n`);
    return;
  }
  if (options.command === "worker") {
    assert.ok(options.profile && options.runId && options.manifest && options.completion, "BrainPet gate worker arguments are incomplete.");
    await runWorker(options);
    return;
  }
  throw new Error("Usage: brainpet-performance-gate-runner.mjs <start|status> <active-30m|idle-24h>");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertPerformanceProfile(profile) {
  assert.equal(typeof profile === "string" && Object.hasOwn(profileScripts, profile), true, `Unknown BrainPet performance profile: ${profile}`);
}

function normalizeWindowsPath(value) {
  return typeof value === "string" ? resolve(value).toLowerCase() : "";
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
