#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { brainPetDistributionContract } from "../../../scripts/brainpet-release-contract.mjs";
import { summarizeBrainPetProcessSoak } from "../dist/brainpet/performance-budget.js";
import { createBrainPetRuntimeTree } from "./brainpet-runtime-tree.mjs";
import {
  assertBrainPetPerformanceReceiptAvailable,
  BrainPetPerformanceReceiptRollbackError,
  removePublishedBrainPetPerformanceReceipt,
  resolveBrainPetPerformanceReceiptPath,
  sha256Bytes,
  validateBrainPetPerformanceCandidate,
  validateBrainPetPerformanceReceipt,
  writeBrainPetPerformanceReceipt,
} from "./brainpet-performance-receipt.mjs";

const temporaryRoots = [];

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("formal performance candidate binds clean source, package receipt, executable and app.asar bytes", () => {
  const fixture = createCandidateFixture();
  const candidate = validateBrainPetPerformanceCandidate(fixture.options);
  assert.equal(candidate.commit, fixture.commit);
  assert.equal(candidate.executableSha256, sha256Bytes(fixture.executableBytes));
  assert.equal(candidate.appAsarSha256, sha256Bytes(fixture.appAsarBytes));
  assert.match(candidate.packageReceiptSha256, /^[a-f0-9]{64}$/);
  assert.match(candidate.runtimeTreeDigest, /^[a-f0-9]{64}$/);

  writeFileSync(fixture.appAsarPath, Buffer.from("tampered-app-asar"));
  assert.throws(() => validateBrainPetPerformanceCandidate(fixture.options), /app\.asar bytes do not match/i);
  writeFileSync(fixture.appAsarPath, fixture.appAsarBytes);
  const unpackedJs = join(dirname(fixture.appAsarPath), "app.asar.unpacked", "fixture.js");
  mkdirSync(dirname(unpackedJs), { recursive: true });
  writeFileSync(unpackedJs, "tampered-unpacked-code");
  assert.throws(() => validateBrainPetPerformanceCandidate(fixture.options), /runtime tree differs/i);
  rmSync(dirname(unpackedJs), { recursive: true, force: true });
  assert.throws(() => validateBrainPetPerformanceCandidate({ ...fixture.options, gitIdentity: { ...fixture.options.gitIdentity, treeDirty: true } }), /clean tracked worktree/i);
  assert.throws(() => validateBrainPetPerformanceCandidate({ ...fixture.options, executablePath: fixture.appAsarPath }), /does not match the package receipt/i);

  const traversalReceipt = JSON.parse(readFileSync(fixture.packageReceiptPath, "utf8"));
  traversalReceipt.appAsar = "../../outside.asar";
  writeFileSync(fixture.packageReceiptPath, `${JSON.stringify(traversalReceipt, null, 2)}\n`);
  assert.throws(() => validateBrainPetPerformanceCandidate(fixture.options), /must stay under/i);
});

test("performance receipt is digest-checked and cannot overwrite an existing success", async () => {
  const fixture = createCandidateFixture();
  const candidate = validateBrainPetPerformanceCandidate(fixture.options);
  const outputRoot = join(fixture.root, "output", "performance");
  const receiptPath = resolveBrainPetPerformanceReceiptPath(candidate, "idle-24h", outputRoot);
  assertBrainPetPerformanceReceiptAvailable(receiptPath);
  const gateResult = createIdleGateResult();
  const runEvidence = createRunEvidence(candidate.commit, "idle-24h");
  const startedAt = new Date(Date.now() - 86_400_001).toISOString();
  const written = await writeBrainPetPerformanceReceipt({ receiptPath, candidate, gateProfile: "idle-24h", startedAt, gateResult, runEvidence });
  assert.equal(written.receipt.candidate.packageReceiptSha256, candidate.packageReceiptSha256);
  assert.equal(validateBrainPetPerformanceReceipt(receiptPath, { candidate, gateProfile: "idle-24h" }).gatePassed, true);
  assert.throws(() => assertBrainPetPerformanceReceiptAvailable(receiptPath), /already exists/i);
  await assert.rejects(
    writeBrainPetPerformanceReceipt({ receiptPath, candidate, gateProfile: "idle-24h", startedAt, gateResult, runEvidence }),
    /EEXIST|exists/i,
  );

  const shortReceiptPath = resolveBrainPetPerformanceReceiptPath(candidate, "idle-24h", join(fixture.root, "output", "short-performance"));
  await assert.rejects(
    writeBrainPetPerformanceReceipt({ receiptPath: shortReceiptPath, candidate, gateProfile: "idle-24h", startedAt: new Date().toISOString(), gateResult, runEvidence }),
    /wall-clock/i,
  );
  assert.equal(existsSync(shortReceiptPath), false, "A short formal run must fail before publishing any receipt bytes.");

  const tampered = JSON.parse(readFileSync(receiptPath, "utf8"));
  tampered.gateResult.idleSoak.samples = 1;
  writeFileSync(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => validateBrainPetPerformanceReceipt(receiptPath), /evidence digest is invalid/i);
  const { evidenceDigest: _oldDigest, ...tamperedCore } = tampered;
  tampered.evidenceDigest = sha256Bytes(Buffer.from(JSON.stringify(tamperedCore)));
  writeFileSync(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => validateBrainPetPerformanceReceipt(receiptPath), /sample count does not match|raw heap samples/i);
});

test("published receipt cleanup reports deletion failures and verifies absence", async () => {
  const fixture = createCandidateFixture();
  const receiptPath = join(fixture.root, "published-receipt.json");
  writeFileSync(receiptPath, "published\n");
  const removalError = new Error("fixture removal failed");
  await assert.rejects(
    removePublishedBrainPetPerformanceReceipt(receiptPath, async () => { throw removalError; }),
    (error) => error === removalError,
  );
  assert.equal(existsSync(receiptPath), true);
  await assert.rejects(
    removePublishedBrainPetPerformanceReceipt(receiptPath, async () => {}),
    /remained after rollback/i,
  );
  assert.equal(existsSync(receiptPath), true);
  await removePublishedBrainPetPerformanceReceipt(receiptPath);
  assert.equal(existsSync(receiptPath), false);
});

test("post-publication validation plus rollback failure identifies the orphan receipt", async () => {
  const fixture = createCandidateFixture();
  const candidate = validateBrainPetPerformanceCandidate(fixture.options);
  const receiptPath = resolveBrainPetPerformanceReceiptPath(candidate, "idle-24h", join(fixture.root, "output", "rollback-failure"));
  const validationError = new Error("fixture post-publication validation failed");
  const removalError = new Error("fixture published receipt removal failed");
  await assert.rejects(
    writeBrainPetPerformanceReceipt({
      receiptPath,
      candidate,
      gateProfile: "idle-24h",
      startedAt: new Date(Date.now() - 86_400_001).toISOString(),
      gateResult: createIdleGateResult(),
      runEvidence: createRunEvidence(candidate.commit, "idle-24h"),
      validatePublishedReceipt: () => { throw validationError; },
      removePublishedReceipt: async () => { throw removalError; },
    }),
    (error) => error instanceof BrainPetPerformanceReceiptRollbackError
      && error.receiptPath === receiptPath
      && error.errors.includes(validationError)
      && error.errors.includes(removalError),
  );
  assert.equal(existsSync(receiptPath), true, "The fixture must preserve the exact orphan that requires lease recovery.");
});

function createCandidateFixture() {
  const root = mkdtempSync(join(tmpdir(), "brainpet-performance-receipt-"));
  temporaryRoots.push(root);
  const packageRoot = join(root, "apps", "desktop", "dist-brainpet", "private-test");
  const executablePath = join(packageRoot, "win-unpacked", "brainpet.exe");
  const appAsarPath = join(packageRoot, "win-unpacked", "resources", "app.asar");
  mkdirSync(dirname(executablePath), { recursive: true });
  mkdirSync(dirname(appAsarPath), { recursive: true });
  const executableBytes = Buffer.from("fixture-brainpet-windows-executable");
  const appAsarBytes = Buffer.from("fixture-brainpet-app-asar");
  writeFileSync(executablePath, executableBytes);
  writeFileSync(appAsarPath, appAsarBytes);
  const runtimeTree = createBrainPetRuntimeTree(join(packageRoot, "win-unpacked"));
  const commit = "a".repeat(40);
  const packageReceiptPath = join(packageRoot, "brainpet-package-receipt-windows-x64.json");
  writeFileSync(packageReceiptPath, `${JSON.stringify({
    schemaVersion: 2,
    product: "brainpet",
    appId: brainPetDistributionContract.identity.appId,
    appVersion: "3.4.0",
    target: "windows-x64",
    releaseMode: "private-test",
    packageTarget: "dir",
    source: { repository: brainPetDistributionContract.identity.repository, commit, treeDirty: false, githubActions: false },
    executable: "win-unpacked/brainpet.exe",
    sha256: sha256Bytes(executableBytes),
    appAsar: "win-unpacked/resources/app.asar",
    appAsarSha256: sha256Bytes(appAsarBytes),
    runtimeTree,
    artifacts: [],
    runtimeReleaseReady: false,
    publicReleaseReady: false,
  }, null, 2)}\n`);
  return {
    root,
    commit,
    packageReceiptPath,
    executablePath,
    appAsarPath,
    executableBytes,
    appAsarBytes,
    options: {
      packageReceiptPath,
      executablePath,
      repoRoot: root,
      gitIdentity: { repository: brainPetDistributionContract.identity.repository, commit, treeDirty: false },
      platform: "win32",
    },
  };
}

function createRunEvidence(commit, profile) {
  return { runId: `${profile}-${commit}-1786900000000-00000000-0000-4000-8000-000000000000`, manifestSha256: "1".repeat(64), resultSha256: "2".repeat(64), executionLogSha256: "3".repeat(64), executionLogBytes: 128, completionCoreDigest: "4".repeat(64) };
}

function createIdleGateResult() {
  const MiB = 1024 * 1024;
  const timeline = Array.from({ length: 289 }, (_, index) => {
    const elapsedMs = index * 300_000;
    const cpuTime100ns = index * 10_000_000;
    const processes = [
      { pid: 100, parentPid: 1, role: "browser", creationTime: "2026-08-17T00:00:00.000Z", totalWorkingSetBytes: 120 * MiB, workingSetBytes: 90 * MiB, privateBytes: 90 * MiB, handleCount: 700, cpuTime100ns },
      { pid: 101, parentPid: 100, role: "renderer", creationTime: "2026-08-17T00:00:00.000Z", totalWorkingSetBytes: 80 * MiB, workingSetBytes: 60 * MiB, privateBytes: 60 * MiB, handleCount: 300, cpuTime100ns: 0 },
    ];
    return { elapsedMs, rootPid: 100, processCount: 2, totalWorkingSetBytes: 200 * MiB, workingSetBytes: 150 * MiB, privateBytes: 150 * MiB, handleCount: 1_000, cpuTime100ns, processes };
  });
  const process = summarizeBrainPetProcessSoak(timeline, 8);
  const heapTimeline = Array.from({ length: 289 }, () => 16 * MiB);
  const { elapsedMs: _elapsedMs, ...idleProcessMetrics } = timeline[0];
  return { ok: true, gateProfile: "idle-24h", gatePassed: true, resourceBudgetEnforced: true, petReadyMs: 500, rendererTargetTitles: ["BrainPet Default Pet"], idleProcessMetrics, idleSoak: { durationMs: 86_400_001, samples: heapTimeline.length, heapGrowthBytes: 0, maxHeapBytes: 16 * MiB, heapTimeline, process } };
}
