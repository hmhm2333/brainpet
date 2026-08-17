#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createBrainPetRuntimeTree } from "../apps/desktop/scripts/brainpet-runtime-tree.mjs";
import { validateBrainPetPreparedPerformanceCandidate } from "../apps/desktop/scripts/brainpet-performance-receipt.mjs";
import { brainPetDistributionContract, brainPetReleaseTargets } from "./brainpet-release-contract.mjs";
import { extractNsisWithWindowsTar, prepareBrainPetPublicPerformanceCandidate } from "./prepare-brainpet-public-performance-candidate.mjs";

const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("public performance preparation binds successful run, aggregate, package, provenance, installer and extracted runtime", () => {
  const fixture = createFixture();
  const prepared = prepareBrainPetPublicPerformanceCandidate(fixture.options);
  assert.equal(prepared.candidate.releaseMode, "public-release");
  assert.equal(prepared.candidate.packageTarget, "installer");
  assert.equal(prepared.candidate.sourceRunId, fixture.runId);
  assert.equal(prepared.candidate.installerSha256, fixture.packageReceipt.artifacts[0].sha256);
  assert.equal(prepared.candidate.executableSha256, fixture.packageReceipt.sha256);
  assert.deepEqual(fixture.provenanceCalls.map((entry) => entry.label).sort(), ["BrainPet prepared candidate-receipt", "BrainPet prepared installer", "BrainPet prepared package-receipt"]);
  assert.ok(existsSync(prepared.manifestPath));

  writeFileSync(join(prepared.outputRoot, "runtime", "resources", "app.asar"), "tampered");
  assert.throws(
    () => validateBrainPetPreparedPerformanceCandidate(prepared.manifestPath, fixture.validationOptions),
    /app\.asar bytes do not match|changed/i,
  );
});

test("preparation rejects an aggregate that does not bind the exact Windows package and rolls back its new output", () => {
  const fixture = createFixture({ mutateCandidate: (candidate) => { candidate.packages.find((entry) => entry.target === "windows-x64").sha256 = "f".repeat(64); } });
  assert.throws(() => prepareBrainPetPublicPerformanceCandidate(fixture.options), /aggregate and Windows package receipt differ|differs from the public aggregate/i);
  assert.equal(existsSync(fixture.outputRoot), false, "Failed preparation must roll back its newly created output root.");
});

test("preparation rejects an extra file in the downloaded package closure", () => {
  const fixture = createFixture({ extraPackageFile: true });
  assert.throws(() => prepareBrainPetPublicPerformanceCandidate(fixture.options), /unreceipted|unexpected/i);
  assert.equal(existsSync(fixture.outputRoot), false);
});

test("preparation rejects a forged Sigstore bundle and rolls back its new output", () => {
  const fixture = createFixture();
  fixture.options.provenanceVerifier = () => {
    throw new Error("Sigstore provenance failed for forged fixture bundle.");
  };
  assert.throws(() => prepareBrainPetPublicPerformanceCandidate(fixture.options), /Sigstore provenance failed/i);
  assert.equal(existsSync(fixture.outputRoot), false);
});

test("preparation stages an exact three-bundle provenance allowlist", () => {
  const fixture = createFixture({ extraProvenanceFile: true });
  const prepared = prepareBrainPetPublicPerformanceCandidate(fixture.options);
  const expected = prepared.manifest.provenance.map((entry) => entry.bundle.split("/").at(-1)).sort();
  assert.deepEqual(readdirSync(join(prepared.outputRoot, "provenance")).sort(), expected);
  assert.equal(expected.includes(`sha256-${"e".repeat(64)}.sigstore.json`), false);
});

test("NSIS archive extraction rejects traversal and conflicting duplicate paths before writing", () => {
  const root = createRoot();
  const installer = join(root, "fixture.exe");
  const runtimeRoot = join(root, "runtime");
  writeFileSync(installer, "fixture-installer");
  mkdirSync(runtimeRoot);
  let calls = 0;
  assert.throws(
    () => extractNsisWithWindowsTar({
      installer,
      runtimeRoot,
      commandRunner: () => {
        calls += 1;
        return { status: 0, stdout: "../escape.exe\nbrainpet.exe\nresources/app.asar\n", stderr: "" };
      },
    }),
    /archive path is unsafe/i,
  );
  assert.equal(calls, 1, "Unsafe archive listing must abort before extraction.");

  assert.throws(
    () => extractNsisWithWindowsTar({
      installer,
      runtimeRoot,
      commandRunner: () => ({ status: 0, stdout: "brainpet.exe\nBrainPet.exe\nresources/app.asar\n", stderr: "" }),
    }),
    /duplicate path/i,
  );
});

function createFixture({ mutateCandidate, extraPackageFile = false, extraProvenanceFile = false } = {}) {
  const root = createRoot();
  const repoRoot = join(root, "repo");
  const sourceRuntime = join(root, "source-runtime");
  const runId = "32001479999";
  const outputRoot = join(repoRoot, "output", "performance-candidates", runId);
  mkdirSync(repoRoot);
  mkdirSync(join(sourceRuntime, "resources"), { recursive: true });
  const executableBytes = Buffer.from("fixture-public-brainpet-executable");
  const appAsarBytes = Buffer.from("fixture-public-brainpet-app-asar");
  writeFileSync(join(sourceRuntime, "brainpet.exe"), executableBytes);
  writeFileSync(join(sourceRuntime, "resources", "app.asar"), appAsarBytes);
  const runtimeTree = createBrainPetRuntimeTree(sourceRuntime);
  const installerBytes = Buffer.from("fixture-public-nsis-installer-bytes");
  const sourceCommit = "a".repeat(40);
  const runAttempt = "1";
  const installerName = "BrainPet-Unsigned-3.4.0-win-x64-setup.exe";
  const packageReceipt = {
    schemaVersion: 2,
    product: "brainpet",
    appId: brainPetDistributionContract.identity.appId,
    appVersion: "3.4.0",
    target: "windows-x64",
    releaseMode: "public-release",
    packageTarget: "installer",
    publicReleaseReady: false,
    runtimeReleaseReady: true,
    installerValidated: true,
    unsignedPolicyValidated: true,
    platformSignatureStatus: "absent-by-policy",
    source: {
      repository: brainPetDistributionContract.identity.repository,
      commit: sourceCommit,
      treeDirty: false,
      githubActions: true,
      workflow: "BrainPet public release gate",
      runId,
      runAttempt,
      runnerEnvironment: "github-hosted",
    },
    executable: "win-unpacked/brainpet.exe",
    sha256: sha256Bytes(executableBytes),
    appAsar: "win-unpacked/resources/app.asar",
    appAsarSha256: sha256Bytes(appAsarBytes),
    runtimeTree,
    artifacts: [{ kind: "nsis", path: installerName, bytes: installerBytes.length, sha256: sha256Bytes(installerBytes) }],
  };
  const packages = brainPetReleaseTargets.map((target) => target.id === "windows-x64"
    ? { ...packageReceipt, provenanceValidated: true }
    : { target: target.id, appVersion: "3.4.0", source: { commit: sourceCommit, runId, runAttempt } });
  const candidateCore = {
    schemaVersion: 2,
    product: "brainpet",
    appId: brainPetDistributionContract.identity.appId,
    appVersion: "3.4.0",
    releaseMode: "public-release",
    sourceCommit,
    sourceRunId: runId,
    sourceRunAttempt: runAttempt,
    physicalChallenge: "b".repeat(64),
    packages,
    rc6GatePassed: true,
    missingEvidence: ["macos-arm64:physical-acceptance", "performance:active-30m", "performance:idle-24h", "windows-x64:physical-acceptance"],
    publicReleaseReady: false,
  };
  const candidate = { ...candidateCore, evidenceDigest: sha256Bytes(Buffer.from(JSON.stringify(candidateCore))), generatedAt: "2026-08-17T00:00:00.000Z" };
  mutateCandidate?.(candidate);
  if (mutateCandidate) {
    const { evidenceDigest: _oldDigest, generatedAt: _generatedAt, ...mutatedCore } = candidate;
    candidate.evidenceDigest = sha256Bytes(Buffer.from(JSON.stringify(mutatedCore)));
  }

  const downloadArtifact = ({ name, destination }) => {
    if (name === "brainpet-public-runtime-current-windows-x64") {
      writeFileSync(join(destination, "brainpet-package-receipt-windows-x64.json"), `${JSON.stringify(packageReceipt, null, 2)}\n`);
      writeFileSync(join(destination, installerName), installerBytes);
      if (extraPackageFile) writeFileSync(join(destination, "extra.exe"), "extra");
    } else if (name === "brainpet-public-candidate-receipt") {
      writeFileSync(join(destination, "brainpet-release-receipt.json"), `${JSON.stringify(candidate, null, 2)}\n`);
    } else if (name === "brainpet-public-provenance") {
      const packageRoot = join(outputRoot, "package");
      const candidateReceiptRoot = join(outputRoot, "candidate-receipt");
      for (const subjectPath of [
        join(packageRoot, "brainpet-package-receipt-windows-x64.json"),
        join(packageRoot, installerName),
        join(candidateReceiptRoot, "brainpet-release-receipt.json"),
      ]) {
        const digest = sha256(subjectPath);
        writeFileSync(join(destination, `sha256-${digest}.sigstore.json`), `${JSON.stringify({ fixture: true, subjectDigest: digest })}\n`);
      }
      if (extraProvenanceFile) writeFileSync(join(destination, `sha256-${"e".repeat(64)}.sigstore.json`), "{}\n");
    } else {
      assert.fail(`Unexpected fixture artifact: ${name}`);
    }
  };
  const provenanceCalls = [];
  const provenanceVerifier = (evidence) => {
    assert.equal(evidence.repository, brainPetDistributionContract.identity.repository);
    assert.equal(evidence.workflowPath, ".github/workflows/brainpet-public-release-gate.yml");
    assert.equal(evidence.workflowName, "BrainPet public release gate");
    assert.equal(evidence.sourceCommit, sourceCommit);
    assert.equal(sha256(evidence.subjectPath), basenameWithoutBundle(evidence.bundlePath));
    provenanceCalls.push(evidence);
  };
  const validationOptions = { repoRoot, gitIdentity: { repository: brainPetDistributionContract.identity.repository, commit: sourceCommit, treeDirty: false }, platform: "win32", provenanceVerifier };
  return {
    root,
    repoRoot,
    outputRoot,
    sourceRuntime,
    sourceCommit,
    runId,
    packageReceipt,
    provenanceCalls,
    validationOptions,
    options: {
      repoRoot,
      outputRoot,
      sourceCommit,
      runId,
      repository: brainPetDistributionContract.identity.repository,
      platform: "win32",
      enforceOutputRoot: false,
      resolveRun: () => ({ id: Number(runId), path: ".github/workflows/brainpet-public-release-gate.yml@refs/heads/main", name: "BrainPet public release gate", head_sha: sourceCommit, conclusion: "success", event: "workflow_dispatch", run_attempt: Number(runAttempt), repository: { full_name: brainPetDistributionContract.identity.repository } }),
      downloadArtifact,
      extractInstaller: ({ runtimeRoot }) => cpSync(sourceRuntime, runtimeRoot, { recursive: true }),
      provenanceVerifier,
    },
  };
}

function createRoot() {
  const root = mkdtempSync(join(tmpdir(), "brainpet-public-performance-"));
  roots.push(root);
  return root;
}

function sha256(path) {
  return sha256Bytes(readFileSync(path));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function basenameWithoutBundle(path) {
  const name = path.split(/[\\/]/).at(-1);
  assert.match(name, /^sha256-([a-f0-9]{64})\.sigstore\.json$/i);
  return name.slice(7, 71);
}
