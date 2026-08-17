#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "../../../scripts/brainpet-release-contract.mjs";
import { sha256Bytes, sha256File } from "./brainpet-performance-receipt.mjs";
import { createBrainPetPerformanceGatePaths, createCleanPerformanceEnvironment, finalizePerformancePublication, queryWindowsProcessIdentity, readBrainPetPerformanceGateStatus, recoverOrRejectPerformanceLease } from "./brainpet-performance-gate-runner.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "..", "..");
const performancePaths = createBrainPetPerformanceGatePaths(join(repoRoot, "output", "performance-tests", `runner-${process.pid}-${randomUUID()}`));
const performanceRoot = performancePaths.performanceRoot;
const runsRoot = performancePaths.runsRoot;
const createdPaths = [];

test.after(() => {
  for (const path of createdPaths.reverse()) rmSync(path, { force: true, recursive: true });
  rmSync(performanceRoot, { force: true, recursive: true });
});

test("runner status requires exact PID creation identity and command binding", () => {
  const fixture = createRunFixture();
  const exactIdentity = { processId: 4242, creationDate: fixture.creationDate, executablePath: process.execPath, commandLine: `node brainpet-performance-gate-runner.mjs worker --run-id ${fixture.runId}` };
  const running = readBrainPetPerformanceGateStatus(fixture.manifestPath, () => exactIdentity, performancePaths);
  assert.equal(running.state, "running");

  const reusedPid = readBrainPetPerformanceGateStatus(fixture.manifestPath, () => ({ ...exactIdentity, creationDate: "2026-08-17T01:00:00.000Z" }), performancePaths);
  assert.equal(reusedPid.state, "interrupted");
  const wrongCommand = readBrainPetPerformanceGateStatus(fixture.manifestPath, () => ({ ...exactIdentity, commandLine: "node unrelated.mjs" }), performancePaths);
  assert.equal(wrongCommand.state, "interrupted");
  assert.equal(readBrainPetPerformanceGateStatus(fixture.manifestPath, () => null, performancePaths).state, "interrupted");
});

test("runner status trusts only a sealed completion record plus a valid success receipt", () => {
  const fixture = createRunFixture();
  writeFileSync(fixture.completionPath, `${JSON.stringify(createCompletion(fixture, false), null, 2)}\n`);
  createdPaths.push(fixture.completionPath);
  assert.equal(readBrainPetPerformanceGateStatus(fixture.manifestPath, () => null, performancePaths).state, "failed");

  const falseSuccess = createCompletion(fixture, true);
  writeFileSync(fixture.completionPath, `${JSON.stringify(falseSuccess, null, 2)}\n`);
  assert.throws(() => readBrainPetPerformanceGateStatus(fixture.manifestPath, () => null, performancePaths), /ENOENT|performance receipt/i);
});

test("runner status rejects a changed formal result even for a failed run", () => {
  const fixture = createRunFixture();
  writeFileSync(fixture.resultPath, "{\"fixture\":true}\n");
  createdPaths.push(fixture.resultPath);
  const completion = createCompletion(fixture, false, sha256File(fixture.resultPath));
  writeFileSync(fixture.completionPath, `${JSON.stringify(completion, null, 2)}\n`);
  createdPaths.push(fixture.completionPath);
  assert.equal(readBrainPetPerformanceGateStatus(fixture.manifestPath, () => null, performancePaths).state, "failed");
  writeFileSync(fixture.resultPath, "{\"fixture\":false}\n");
  assert.throws(() => readBrainPetPerformanceGateStatus(fixture.manifestPath, () => null, performancePaths), /different formal-result bytes/i);
});

test("formal runner environment drops inherited BrainPet/OpenPets bypass controls", () => {
  const originalBrainPet = process.env.BRAINPET_ENFORCE_RESOURCE_BUDGET;
  const originalOpenPets = process.env.OPENPETS_BRAINPET_EXERCISER;
  process.env.BRAINPET_ENFORCE_RESOURCE_BUDGET = "0";
  process.env.OPENPETS_BRAINPET_EXERCISER = "unsafe";
  try {
    const clean = createCleanPerformanceEnvironment({ BRAINPET_ENFORCE_RESOURCE_BUDGET: "1" });
    assert.equal(clean.BRAINPET_ENFORCE_RESOURCE_BUDGET, "1");
    assert.equal(clean.OPENPETS_BRAINPET_EXERCISER, undefined);
    assert.equal(new Set(Object.keys(clean).map((key) => key.toLowerCase())).size, Object.keys(clean).length, "Windows environment keys must be unique case-insensitively.");
  } finally {
    if (originalBrainPet === undefined) delete process.env.BRAINPET_ENFORCE_RESOURCE_BUDGET; else process.env.BRAINPET_ENFORCE_RESOURCE_BUDGET = originalBrainPet;
    if (originalOpenPets === undefined) delete process.env.OPENPETS_BRAINPET_EXERCISER; else process.env.OPENPETS_BRAINPET_EXERCISER = originalOpenPets;
  }
});

test("startup lease handoff cannot be stolen before its manifest is published", () => {
  mkdirSync(performanceRoot, { recursive: true });
  const leasePath = join(performanceRoot, "brainpet-performance-gate.lease.json");
  const runId = `active-30m-${"c".repeat(40)}-1786900000000-${randomUUID()}`;
  const owner = { pid: 5151, creationDate: "2026-08-17T00:00:00.000Z", executable: process.execPath, commandNeedles: ["brainpet-performance-gate-runner.mjs", "start"] };
  writeFileSync(leasePath, `${JSON.stringify({ runId, profile: "active-30m", manifest: toRepoRelative(join(runsRoot, `${runId}.manifest.json`)), owner, phase: "starting", activeChild: null })}\n`);
  createdPaths.push(leasePath);
  const identity = { processId: owner.pid, creationDate: owner.creationDate, executablePath: owner.executable, commandLine: `node brainpet-performance-gate-runner.mjs start active-30m` };
  assert.throws(() => recoverOrRejectPerformanceLease(() => identity, () => assert.fail("active startup must not be terminated"), performancePaths), /already owned/i);
  assert.equal(readFileSync(leasePath, "utf8").includes(runId), true);
  rmSync(leasePath, { force: true });
  createdPaths.pop();
});

test("interrupted worker recovery terminates its exact leased child tree before removing the lease", () => {
  mkdirSync(performanceRoot, { recursive: true });
  const leasePath = join(performanceRoot, "brainpet-performance-gate.lease.json");
  const runId = `idle-24h-${"d".repeat(40)}-1786900000000-${randomUUID()}`;
  const wrapper = { pid: 6262, creationDate: "2026-08-17T00:00:00.000Z", executable: process.execPath, commandNeedles: ["brainpet-performance-gate-runner.mjs", "child", runId], descendantExpectation: { executableBasename: "node.exe", commandNeedles: ["node.exe", "fixture-child"] } };
  const activeChild = { wrapper, process: null };
  writeFileSync(leasePath, `${JSON.stringify({ runId, profile: "idle-24h", owner: { pid: 1 }, phase: "child-running", activeChild })}\n`);
  createdPaths.push(leasePath);
  let terminated = null;
  const query = (pid) => pid === wrapper.pid ? { processId: pid, creationDate: wrapper.creationDate, executablePath: wrapper.executable, commandLine: `node brainpet-performance-gate-runner.mjs child --run-id ${runId}` } : null;
  assert.equal(recoverOrRejectPerformanceLease(query, (identity) => { terminated = identity; }, performancePaths), true);
  assert.deepEqual(terminated, activeChild);
  assert.equal(existsSyncForTest(leasePath), false);
  createdPaths.pop();
});

test("recovery kills an orphan descendant when the leased wrapper dies before reporting the child", { skip: process.platform !== "win32" }, async () => {
  mkdirSync(performanceRoot, { recursive: true });
  const leasePath = performancePaths.leasePath;
  const runId = `active-30m-${"e".repeat(40)}-1786900000000-${randomUUID()}`;
  const token = `brainpet-wrapper-fault-${randomUUID()}`;
  const wrapperCode = `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)",${JSON.stringify(token)}],{detached:true,stdio:"ignore"});process.stdout.write(String(child.pid)+"\\n");child.unref();setTimeout(()=>process.exit(0),1200);`;
  const wrapper = spawn(process.execPath, ["-e", wrapperCode, token], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  const wrapperExit = once(wrapper, "exit");
  let childIdentity = null;
  try {
    const wrapperIdentity = await waitForIdentity(wrapper.pid);
    const childPid = await readPidLine(wrapper);
    childIdentity = await waitForIdentity(childPid);
    const [exitCode] = await wrapperExit;
    assert.equal(exitCode, 0);
    assert.equal(queryWindowsProcessIdentity(wrapper.pid), null, "Fault injection requires the wrapper root to be gone.");
    assert.ok(queryWindowsProcessIdentity(childPid), "Fault injection failed to leave the detached descendant alive.");
    writeFileSync(leasePath, `${JSON.stringify({
      runId,
      profile: "active-30m",
      owner: { pid: 1 },
      revision: 1,
      phase: "child-wrapper-ready",
      activeChild: {
        wrapper: {
          pid: wrapper.pid,
          creationDate: wrapperIdentity.creationDate,
          executable: wrapperIdentity.executablePath,
          commandNeedles: [token],
          descendantExpectation: { executableBasename: childIdentity.executablePath.split(/[\\/]/).at(-1), commandNeedles: [token] },
        },
        process: null,
      },
    })}\n`);
    assert.equal(recoverOrRejectPerformanceLease(queryWindowsProcessIdentity, undefined, performancePaths), true);
    assert.equal(queryWindowsProcessIdentity(childPid), null, "Recovery released the lease before terminating the orphan descendant.");
  } finally {
    try { wrapper.kill(); } catch {}
    if (childIdentity && queryWindowsProcessIdentity(childIdentity.pid)?.creationDate === childIdentity.creationDate) {
      try { process.kill(childIdentity.pid); } catch {}
    }
    rmSync(leasePath, { force: true });
  }
});

test("Windows Job supervisor exits promptly after a successful complete process tree", { skip: process.platform !== "win32" }, async () => {
  const supervised = await runWindowsJobSupervisorFixture(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(supervised.exitCode, 0, JSON.stringify(supervised));
  assert.equal(supervised.result.exitCode, 0);
  assert.equal(supervised.result.jobQuiescent, true);
  assert.equal(supervised.result.remainingProcesses, 0);
  assert.equal(queryWindowsProcessIdentity(supervised.ready.pid), null);
});

test("Windows Job supervisor rejects and terminates a successful root that leaves a detached descendant", { skip: process.platform !== "win32" }, async () => {
  const descendantPidPath = join(performanceRoot, `detached-${randomUUID()}.pid`);
  const token = `brainpet-job-leak-${randomUUID()}`;
  const rootCode = `const {spawn}=require("node:child_process");const {writeFileSync}=require("node:fs");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)",${JSON.stringify(token)}],{detached:true,stdio:"ignore"});writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid));child.unref();`;
  const supervised = await runWindowsJobSupervisorFixture(process.execPath, ["-e", rootCode, token]);
  const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
  assert.notEqual(supervised.exitCode, 0);
  assert.equal(supervised.result.exitCode, 0, "The fixture root itself must succeed before leaving its background descendant.");
  assert.equal(supervised.result.jobQuiescent, false);
  assert.ok(supervised.result.remainingProcesses > 0);
  assert.equal(queryWindowsProcessIdentity(descendantPid), null, "The Job must terminate the detached descendant before the supervisor exits.");
});

test("terminating the Windows Job supervisor kills its leased command", { skip: process.platform !== "win32" }, async () => {
  const supervised = await runWindowsJobSupervisorFixture(process.execPath, ["-e", "setInterval(()=>{},1000)"], { interruptAfterResume: true });
  assert.notEqual(supervised.exitCode, 0);
  assert.equal(queryWindowsProcessIdentity(supervised.ready.pid), null, "KILL_ON_JOB_CLOSE must terminate the leased command with its supervisor.");
});

test("a corrupt performance lease fails closed and is not discarded", () => {
  mkdirSync(performanceRoot, { recursive: true });
  const leasePath = join(performanceRoot, "brainpet-performance-gate.lease.json");
  writeFileSync(leasePath, "{not-json\n");
  createdPaths.push(leasePath);
  assert.throws(() => recoverOrRejectPerformanceLease(() => null, () => {}, performancePaths), /JSON|Unexpected token|property name/i);
  assert.equal(readFileSync(leasePath, "utf8"), "{not-json\n");
  rmSync(leasePath, { force: true });
  createdPaths.pop();
});

test("completion publication failure rolls back the newly published success receipt", async () => {
  mkdirSync(performanceRoot, { recursive: true });
  const completionPath = join(performanceRoot, `occupied-${randomUUID()}.completion.json`);
  const receiptPath = join(performanceRoot, `published-${randomUUID()}.receipt.json`);
  writeFileSync(completionPath, "occupied\n");
  writeFileSync(receiptPath, "published\n");
  let releaseCount = 0;
  await assert.rejects(
    finalizePerformancePublication({ completionPath, completion: { succeeded: true }, writtenReceiptPath: receiptPath, releaseLease: () => { releaseCount += 1; } }),
    /EEXIST|exists/i,
  );
  assert.equal(readFileSync(completionPath, "utf8"), "occupied\n");
  assert.equal(existsSyncForTest(receiptPath), false);
  assert.equal(releaseCount, 1, "A successfully rolled-back publication failure must release its recovery lease.");
  rmSync(completionPath, { force: true });
});

test("receipt rollback failure preserves the recovery lease and both errors", async () => {
  const completionError = new Error("fixture completion publication failed");
  const rollbackError = new Error("fixture receipt rollback failed");
  let releaseCount = 0;
  await assert.rejects(
    finalizePerformancePublication({
      completionPath: "unused-completion.json",
      completion: { succeeded: true },
      writtenReceiptPath: "occupied-receipt.json",
      writeCompletion: async () => { throw completionError; },
      removeReceipt: async () => { throw rollbackError; },
      releaseLease: () => { releaseCount += 1; },
    }),
    (error) => error instanceof AggregateError && error.errors.includes(completionError) && error.errors.includes(rollbackError) && /preserving the recovery lease/i.test(error.message),
  );
  assert.equal(releaseCount, 0, "A failed receipt rollback must keep the recovery lease fail-closed.");
});

function createRunFixture() {
  mkdirSync(runsRoot, { recursive: true });
  const commit = "b".repeat(40);
  const runId = `idle-24h-${commit}-1786900000000-${randomUUID()}`;
  const manifestPath = join(runsRoot, `${runId}.manifest.json`);
  const completionPath = join(runsRoot, `${runId}.completion.json`);
  const resultPath = join(runsRoot, `${runId}.result.json`);
  const logPath = join(runsRoot, `${runId}.log`);
  const stagingRoot = join(runsRoot, `${runId}.candidate`);
  const leasePath = join(performanceRoot, "brainpet-performance-gate.lease.json");
  const receiptPath = join(performanceRoot, `brainpet-idle-24h-${commit}.json`);
  const creationDate = "2026-08-17T00:00:00.000Z";
  writeFileSync(logPath, "fixture\n");
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 2,
    kind: "brainpet-performance-gate-run",
    runId,
    profile: "idle-24h",
    source: { repository: brainPetDistributionContract.identity.repository, commit, treeDirty: false },
    startedAt: creationDate,
    expectedReceipt: toRepoRelative(receiptPath),
    result: toRepoRelative(resultPath),
    log: toRepoRelative(logPath),
    completion: toRepoRelative(completionPath),
    stagingRoot: toRepoRelative(stagingRoot),
    lease: toRepoRelative(leasePath),
    runner: { pid: 4242, creationDate, executable: process.execPath, commandNeedles: ["brainpet-performance-gate-runner.mjs", "worker", runId] },
  }, null, 2)}\n`);
  createdPaths.push(manifestPath, logPath);
  return { commit, runId, manifestPath, completionPath, resultPath, logPath, creationDate };
}

async function runWindowsJobSupervisorFixture(command, args, { interruptAfterResume = false } = {}) {
  mkdirSync(runsRoot, { recursive: true });
  const controlId = randomUUID();
  const runId = `active-30m-${"9".repeat(40)}-1786900000000-${randomUUID()}`;
  const launchPermitPath = join(runsRoot, `.${controlId}.launch.json`);
  const readyPath = join(runsRoot, `.${controlId}.ready.json`);
  const resumePermitPath = join(runsRoot, `.${controlId}.resume.json`);
  const resultPath = join(runsRoot, `.${controlId}.result.json`);
  const supervisorScript = join(appDir, "scripts", "brainpet-windows-job-supervisor.ps1");
  const supervisor = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", supervisorScript,
    "-RunId", runId,
    "-LaunchPermitPath", launchPermitPath,
    "-ReadyPath", readyPath,
    "-ResumePermitPath", resumePermitPath,
    "-ResultPath", resultPath,
  ], {
    cwd: repoRoot,
    env: {
      ...createCleanPerformanceEnvironment(),
      BRAINPET_WRAPPED_CHILD_SPEC: JSON.stringify({ command, args, cwd: repoRoot, environmentEntries: Object.entries(createCleanPerformanceEnvironment()).map(([name, value]) => `${name}=${value}`) }),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  supervisor.stderr.setEncoding("utf8");
  supervisor.stderr.on("data", (chunk) => { stderr += chunk; });
  const completion = once(supervisor, "exit");
  writeFileSync(launchPermitPath, `${JSON.stringify({ runId })}\n`);
  await Promise.race([
    waitForTestPath(readyPath, 30_000),
    completion.then(([exitCode, signal]) => { throw new Error(`Windows Job supervisor exited before readiness (exit=${exitCode}, signal=${signal}): ${stderr}`); }),
  ]);
  const ready = JSON.parse(readFileSync(readyPath, "utf8"));
  writeFileSync(resumePermitPath, `${JSON.stringify({ runId, pid: ready.pid })}\n`);
  if (interruptAfterResume) {
    await waitForTestProcess(ready.pid, 5_000);
    supervisor.kill();
  }
  const [exitCode, signal] = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Windows Job supervisor fixture timed out.")), 30_000);
    completion.then((value) => { clearTimeout(timer); resolvePromise(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
  if (interruptAfterResume) {
    assert.ok(signal || exitCode !== 0, "The interrupted supervisor unexpectedly reported success.");
    await waitForTestProcessExit(ready.pid, 10_000);
    return { exitCode, ready, result: null };
  }
  assert.equal(signal, null, stderr);
  assert.equal(existsSync(resultPath), true, stderr || "Windows Job supervisor did not publish a result.");
  return { exitCode, ready, result: JSON.parse(readFileSync(resultPath, "utf8")) };
}

async function waitForTestPath(path, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for fixture path: ${path}`);
}

async function waitForTestProcess(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (queryWindowsProcessIdentity(pid)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for fixture process ${pid}.`);
}

async function waitForTestProcessExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!queryWindowsProcessIdentity(pid)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for fixture process ${pid} to exit.`);
}

function createCompletion(fixture, succeeded, resultSha256 = null) {
  const logBytes = readFileSync(fixture.logPath);
  const core = {
    runId: fixture.runId,
    profile: "idle-24h",
    sourceCommit: fixture.commit,
    succeeded,
    exitCode: succeeded ? 0 : 1,
    completedAt: "2026-08-17T01:00:00.000Z",
    error: succeeded ? null : "fixture failure",
    manifestSha256: sha256File(fixture.manifestPath),
    resultSha256,
    executionLogSha256: sha256Bytes(logBytes),
    executionLogBytes: logBytes.length,
  };
  return { schemaVersion: 2, kind: "brainpet-performance-gate-completion", ...core, completionCoreDigest: sha256Bytes(Buffer.from(JSON.stringify(core))), receiptSha256: succeeded ? "f".repeat(64) : null };
}

function toRepoRelative(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function existsSyncForTest(path) {
  try { readFileSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function waitForIdentity(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const identity = queryWindowsProcessIdentity(pid);
    if (identity) return identity;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out resolving test process identity for PID ${pid}.`);
}

async function readPidLine(child) {
  let buffered = "";
  for await (const chunk of child.stdout) {
    buffered += chunk.toString("utf8");
    const match = buffered.match(/^(\d+)\r?\n/);
    if (match) return Number(match[1]);
  }
  throw new Error("Fault-injection wrapper exited without reporting its child PID.");
}
