#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { brainPetDistributionContract } from "../../../scripts/brainpet-release-contract.mjs";
import {
  assertBrainPetPerformanceReceiptAvailable,
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

  writeFileSync(fixture.appAsarPath, Buffer.from("tampered-app-asar"));
  assert.throws(() => validateBrainPetPerformanceCandidate(fixture.options), /app\.asar bytes do not match/i);
  writeFileSync(fixture.appAsarPath, fixture.appAsarBytes);
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
  const gateResult = { ok: true, gateProfile: "idle-24h", gatePassed: true, idleSoak: { samples: 289, durationMs: 86_400_001 } };
  const written = await writeBrainPetPerformanceReceipt({ receiptPath, candidate, gateProfile: "idle-24h", startedAt: "2026-08-17T00:00:00.000Z", gateResult });
  assert.equal(written.receipt.candidate.packageReceiptSha256, candidate.packageReceiptSha256);
  assert.equal(validateBrainPetPerformanceReceipt(receiptPath, { candidate, gateProfile: "idle-24h" }).gatePassed, true);
  assert.throws(() => assertBrainPetPerformanceReceiptAvailable(receiptPath), /already exists/i);
  await assert.rejects(
    writeBrainPetPerformanceReceipt({ receiptPath, candidate, gateProfile: "idle-24h", startedAt: "2026-08-17T00:00:00.000Z", gateResult }),
    /EEXIST|exists/i,
  );

  const tampered = JSON.parse(readFileSync(receiptPath, "utf8"));
  tampered.gateResult.idleSoak.samples = 1;
  writeFileSync(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => validateBrainPetPerformanceReceipt(receiptPath), /evidence digest is invalid/i);
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
