#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "../../../scripts/brainpet-release-contract.mjs";
import { sha256Bytes, sha256File } from "./brainpet-performance-receipt.mjs";
import { createCleanPerformanceEnvironment, readBrainPetPerformanceGateStatus, recoverOrRejectPerformanceLease } from "./brainpet-performance-gate-runner.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "..", "..");
const performanceRoot = join(repoRoot, "output", "performance");
const runsRoot = join(performanceRoot, "runs");
const createdPaths = [];

test.after(() => {
  for (const path of createdPaths.reverse()) rmSync(path, { force: true, recursive: true });
});

test("runner status requires exact PID creation identity and command binding", () => {
  const fixture = createRunFixture();
  const exactIdentity = { processId: 4242, creationDate: fixture.creationDate, executablePath: process.execPath, commandLine: `node brainpet-performance-gate-runner.mjs worker --run-id ${fixture.runId}` };
  const running = readBrainPetPerformanceGateStatus(fixture.manifestPath, () => exactIdentity);
  assert.equal(running.state, "running");

  const reusedPid = readBrainPetPerformanceGateStatus(fixture.manifestPath, () => ({ ...exactIdentity, creationDate: "2026-08-17T01:00:00.000Z" }));
  assert.equal(reusedPid.state, "interrupted");
  const wrongCommand = readBrainPetPerformanceGateStatus(fixture.manifestPath, () => ({ ...exactIdentity, commandLine: "node unrelated.mjs" }));
  assert.equal(wrongCommand.state, "interrupted");
  assert.equal(readBrainPetPerformanceGateStatus(fixture.manifestPath, () => null).state, "interrupted");
});

test("runner status trusts only a sealed completion record plus a valid success receipt", () => {
  const fixture = createRunFixture();
  writeFileSync(fixture.completionPath, `${JSON.stringify(createCompletion(fixture, false), null, 2)}\n`);
  createdPaths.push(fixture.completionPath);
  assert.equal(readBrainPetPerformanceGateStatus(fixture.manifestPath, () => null).state, "failed");

  const falseSuccess = createCompletion(fixture, true);
  writeFileSync(fixture.completionPath, `${JSON.stringify(falseSuccess, null, 2)}\n`);
  assert.throws(() => readBrainPetPerformanceGateStatus(fixture.manifestPath, () => null), /ENOENT|performance receipt/i);
});

test("runner status rejects a changed formal result even for a failed run", () => {
  const fixture = createRunFixture();
  writeFileSync(fixture.resultPath, "{\"fixture\":true}\n");
  createdPaths.push(fixture.resultPath);
  const completion = createCompletion(fixture, false, sha256File(fixture.resultPath));
  writeFileSync(fixture.completionPath, `${JSON.stringify(completion, null, 2)}\n`);
  createdPaths.push(fixture.completionPath);
  assert.equal(readBrainPetPerformanceGateStatus(fixture.manifestPath, () => null).state, "failed");
  writeFileSync(fixture.resultPath, "{\"fixture\":false}\n");
  assert.throws(() => readBrainPetPerformanceGateStatus(fixture.manifestPath, () => null), /different formal-result bytes/i);
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
  assert.throws(() => recoverOrRejectPerformanceLease(() => identity, () => assert.fail("active startup must not be terminated")), /already owned/i);
  assert.equal(readFileSync(leasePath, "utf8").includes(runId), true);
  rmSync(leasePath, { force: true });
  createdPaths.pop();
});

test("interrupted worker recovery terminates its exact leased child tree before removing the lease", () => {
  mkdirSync(performanceRoot, { recursive: true });
  const leasePath = join(performanceRoot, "brainpet-performance-gate.lease.json");
  const runId = `idle-24h-${"d".repeat(40)}-1786900000000-${randomUUID()}`;
  const activeChild = { pid: 6262, creationDate: "2026-08-17T00:00:00.000Z", executable: process.execPath, commandNeedles: ["brainpet-performance-gate-runner.mjs", "child", runId] };
  writeFileSync(leasePath, `${JSON.stringify({ runId, profile: "idle-24h", owner: { pid: 1 }, phase: "child-running", activeChild })}\n`);
  createdPaths.push(leasePath);
  let terminated = null;
  const query = (pid) => pid === activeChild.pid ? { processId: pid, creationDate: activeChild.creationDate, executablePath: activeChild.executable, commandLine: `node brainpet-performance-gate-runner.mjs child --run-id ${runId}` } : null;
  assert.equal(recoverOrRejectPerformanceLease(query, (identity) => { terminated = identity; }), true);
  assert.deepEqual(terminated, activeChild);
  assert.equal(existsSyncForTest(leasePath), false);
  createdPaths.pop();
});

test("a corrupt performance lease fails closed and is not discarded", () => {
  mkdirSync(performanceRoot, { recursive: true });
  const leasePath = join(performanceRoot, "brainpet-performance-gate.lease.json");
  writeFileSync(leasePath, "{not-json\n");
  createdPaths.push(leasePath);
  assert.throws(() => recoverOrRejectPerformanceLease(() => null, () => {}), /JSON|Unexpected token|property name/i);
  assert.equal(readFileSync(leasePath, "utf8"), "{not-json\n");
  rmSync(leasePath, { force: true });
  createdPaths.pop();
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
