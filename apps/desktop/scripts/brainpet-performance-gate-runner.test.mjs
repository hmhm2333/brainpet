#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "../../../scripts/brainpet-release-contract.mjs";
import { readBrainPetPerformanceGateStatus } from "./brainpet-performance-gate-runner.mjs";

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

test("runner status trusts only an immutable completion record plus a valid success receipt", () => {
  const fixture = createRunFixture();
  writeFileSync(fixture.completionPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "brainpet-performance-gate-completion",
    runId: fixture.runId,
    profile: "idle-24h",
    sourceCommit: fixture.commit,
    succeeded: false,
    exitCode: 1,
    completedAt: "2026-08-17T01:00:00.000Z",
    error: "fixture failure",
  }, null, 2)}\n`);
  createdPaths.push(fixture.completionPath);
  assert.equal(readBrainPetPerformanceGateStatus(fixture.manifestPath, () => null).state, "failed");

  const falseSuccess = JSON.parse(JSON.stringify({
    schemaVersion: 1,
    kind: "brainpet-performance-gate-completion",
    runId: fixture.runId,
    profile: "idle-24h",
    sourceCommit: fixture.commit,
    succeeded: true,
    exitCode: 0,
    completedAt: "2026-08-17T01:00:00.000Z",
    error: null,
  }));
  writeFileSync(fixture.completionPath, `${JSON.stringify(falseSuccess, null, 2)}\n`);
  assert.throws(() => readBrainPetPerformanceGateStatus(fixture.manifestPath, () => null), /ENOENT|performance receipt/i);
});

function createRunFixture() {
  mkdirSync(runsRoot, { recursive: true });
  const commit = "b".repeat(40);
  const runId = `idle-24h-${commit}-1786900000000-${randomUUID()}`;
  const manifestPath = join(runsRoot, `${runId}.json`);
  const completionPath = join(runsRoot, `${runId}.completion.json`);
  const logPath = join(runsRoot, `${runId}.log`);
  const receiptPath = join(performanceRoot, `brainpet-idle-24h-${commit}.json`);
  const creationDate = "2026-08-17T00:00:00.000Z";
  writeFileSync(logPath, "fixture\n");
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "brainpet-performance-gate-run",
    runId,
    profile: "idle-24h",
    source: { repository: brainPetDistributionContract.identity.repository, commit, treeDirty: false },
    startedAt: creationDate,
    expectedReceipt: toRepoRelative(receiptPath),
    log: toRepoRelative(logPath),
    completion: toRepoRelative(completionPath),
    runner: { pid: 4242, creationDate, executable: process.execPath, commandNeedles: ["brainpet-performance-gate-runner.mjs", "worker", runId] },
  }, null, 2)}\n`);
  createdPaths.push(manifestPath, logPath);
  return { commit, runId, manifestPath, completionPath, creationDate };
}

function toRepoRelative(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}
