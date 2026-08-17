#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBrainPetPreparedPerformanceManifest,
  validateBrainPetPreparedPerformanceCandidate,
} from "../apps/desktop/scripts/brainpet-performance-receipt.mjs";
import { brainPetDistributionContract, brainPetReleaseTargets } from "./brainpet-release-contract.mjs";
import { brainPetPublicReleaseWorkflow, verifyBrainPetSigstoreSubject } from "./brainpet-sigstore-provenance.mjs";
import { validateBrainPetPackageArtifactClosure } from "./stage-brainpet-package-artifacts.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, "..");
const artifactNames = Object.freeze({
  package: "brainpet-public-runtime-current-windows-x64",
  candidateReceipt: "brainpet-public-candidate-receipt",
  provenance: "brainpet-public-provenance",
});

export function prepareBrainPetPublicPerformanceCandidate(options) {
  const platform = options.platform ?? process.platform;
  assert.equal(platform, "win32", "Preparing the formal BrainPet performance candidate currently requires Windows.");
  const repoRoot = realpathSync.native(resolve(options.repoRoot ?? defaultRepoRoot));
  const repository = options.repository ?? brainPetDistributionContract.identity.repository;
  const sourceCommit = options.sourceCommit ?? resolveGitCommit(repoRoot);
  const runId = String(options.runId ?? "");
  assert.equal(repository, brainPetDistributionContract.identity.repository, "Prepared BrainPet candidate repository is invalid.");
  assert.match(sourceCommit, /^[a-f0-9]{40}$/i, "Prepared BrainPet candidate requires an exact source commit.");
  assert.match(runId, /^\d{1,20}$/, "Prepared BrainPet candidate run id is invalid.");
  const outputRoot = resolve(options.outputRoot ?? join(repoRoot, "output", "performance-candidates", runId));
  if (options.enforceOutputRoot !== false) assertUnderRoot(outputRoot, join(repoRoot, "output", "performance-candidates"), "Prepared BrainPet candidate output");
  assert.equal(existsSync(outputRoot), false, `Prepared BrainPet candidate output already exists: ${outputRoot}`);

  const resolveRun = options.resolveRun ?? resolveGitHubRun;
  const downloadArtifact = options.downloadArtifact ?? downloadGitHubArtifact;
  const extractInstaller = options.extractInstaller ?? extractNsisWithWindowsTar;
  let created = false;
  let downloadedProvenanceRoot = null;
  try {
    const run = resolveRun({ repository, runId });
    validateSourceRun(run, { repository, runId, sourceCommit });
    mkdirSync(outputRoot, { recursive: true });
    created = true;
    const packageRoot = join(outputRoot, "package");
    const candidateReceiptRoot = join(outputRoot, "candidate-receipt");
    const provenanceRoot = join(outputRoot, "provenance");
    const runtimeRoot = join(outputRoot, "runtime");
    for (const path of [packageRoot, candidateReceiptRoot, provenanceRoot]) mkdirSync(path);
    downloadedProvenanceRoot = mkdtempSync(join(tmpdir(), "brainpet-public-provenance-"));
    downloadArtifact({ repository, runId, name: artifactNames.package, destination: packageRoot });
    downloadArtifact({ repository, runId, name: artifactNames.candidateReceipt, destination: candidateReceiptRoot });
    downloadArtifact({ repository, runId, name: artifactNames.provenance, destination: downloadedProvenanceRoot });

    const closure = validateBrainPetPackageArtifactClosure(packageRoot, "windows-x64");
    assert.equal(closure.receipt.releaseMode, "public-release");
    assert.equal(closure.receipt.packageTarget, "installer");
    assert.equal(closure.receipt.runtimeReleaseReady, true);
    assert.equal(closure.receipt.source.repository, repository);
    assert.equal(closure.receipt.source.commit.toLowerCase(), sourceCommit.toLowerCase());
    assert.equal(String(closure.receipt.source.runId), runId);
    assert.equal(String(closure.receipt.source.runAttempt), String(run.run_attempt));
    assert.equal(closure.receipt.source.githubActions, true);
    assert.equal(closure.receipt.source.runnerEnvironment, "github-hosted");
    assert.equal(closure.receipt.artifacts.length, 1, "Windows performance preparation requires exactly one installer.");
    const installerRecord = closure.receipt.artifacts[0];
    assert.equal(installerRecord.kind, "nsis", "Windows performance preparation requires the NSIS artifact.");
    const installer = closure.artifactPaths[0];

    assertExactEntries(candidateReceiptRoot, ["brainpet-release-receipt.json"], "BrainPet public-candidate receipt artifact");
    const candidateReceiptPath = join(candidateReceiptRoot, "brainpet-release-receipt.json");
    const candidateReceipt = readJson(candidateReceiptPath, "BrainPet public-candidate receipt");
    validateAggregateCandidate(candidateReceipt, closure.receipt, { repository, runId, sourceCommit, runAttempt: run.run_attempt });
    validateDownloadedProvenanceDirectory(downloadedProvenanceRoot);

    mkdirSync(runtimeRoot);
    extractInstaller({ installer, runtimeRoot });
    assertExtractedRuntimeIsSafe(runtimeRoot);
    const executable = join(runtimeRoot, "brainpet.exe");
    const appAsar = join(runtimeRoot, "resources", "app.asar");
    assertRegularFile(executable, "Prepared BrainPet executable");
    assertRegularFile(appAsar, "Prepared BrainPet app.asar");

    const subjectRecords = [
      createProvenanceRecord("candidate-receipt", candidateReceiptPath, downloadedProvenanceRoot, provenanceRoot, outputRoot),
      createProvenanceRecord("package-receipt", closure.receiptPath, downloadedProvenanceRoot, provenanceRoot, outputRoot),
      createProvenanceRecord("installer", installer, downloadedProvenanceRoot, provenanceRoot, outputRoot),
    ];
    validateSelectedProvenanceDirectory(provenanceRoot, subjectRecords.map((entry) => basename(entry.bundle)));
    const manifestCore = {
      schemaVersion: 1,
      kind: "brainpet-public-performance-candidate",
      repository,
      sourceCommit: sourceCommit.toLowerCase(),
      sourceRunId: runId,
      sourceRunAttempt: String(run.run_attempt),
      workflow: brainPetPublicReleaseWorkflow.name,
      preparedAt: new Date().toISOString(),
      candidateReceipt: "candidate-receipt/brainpet-release-receipt.json",
      candidateReceiptSha256: sha256(candidateReceiptPath),
      packageReceipt: "package/brainpet-package-receipt-windows-x64.json",
      packageReceiptSha256: sha256(closure.receiptPath),
      installer: toPortableRelative(outputRoot, installer),
      installerSha256: installerRecord.sha256.toLowerCase(),
      runtimeRoot: "runtime",
      executable: "runtime/brainpet.exe",
      executableSha256: closure.receipt.sha256.toLowerCase(),
      appAsar: "runtime/resources/app.asar",
      appAsarSha256: closure.receipt.appAsarSha256.toLowerCase(),
      runtimeTreeDigest: closure.receipt.runtimeTree.digest.toLowerCase(),
      provenance: subjectRecords,
    };
    const manifest = createBrainPetPreparedPerformanceManifest(manifestCore);
    const manifestPath = join(outputRoot, "brainpet-performance-candidate.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const candidate = validateBrainPetPreparedPerformanceCandidate(manifestPath, {
      repoRoot,
      gitIdentity: { repository, commit: sourceCommit, treeDirty: false },
      platform,
      provenanceVerifier: options.provenanceVerifier ?? verifyBrainPetSigstoreSubject,
    });
    assert.equal(candidate.sourceRunId, runId);
    return Object.freeze({ outputRoot, manifestPath, manifest, candidate });
  } catch (error) {
    if (created) rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (downloadedProvenanceRoot) rmSync(downloadedProvenanceRoot, { recursive: true, force: true });
  }
}

export function extractNsisWithWindowsTar({ installer, runtimeRoot, commandRunner = spawnSync }) {
  assertRegularFile(installer, "BrainPet NSIS installer");
  assertDirectory(runtimeRoot, "BrainPet extraction directory");
  assert.deepEqual(readdirSync(runtimeRoot), [], "BrainPet extraction directory must be empty.");
  const listed = commandRunner("tar.exe", ["-tf", installer], { encoding: "utf8", timeout: 300_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(listed.status, 0, listed.error?.message || listed.stderr || "Unable to inspect the BrainPet NSIS archive.");
  const entries = String(listed.stdout ?? "").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  assert.ok(entries.length > 0, "BrainPet NSIS archive is empty.");
  const normalized = new Set();
  for (const entry of entries) {
    assertPortableArchiveEntry(entry);
    const key = entry.replace(/\/$/, "").toLowerCase();
    assert.equal(normalized.has(key), false, `BrainPet NSIS archive contains a duplicate path: ${entry}`);
    normalized.add(key);
  }
  assert.equal(normalized.has("brainpet.exe"), true, "BrainPet NSIS archive lacks brainpet.exe.");
  assert.equal(normalized.has("resources/app.asar"), true, "BrainPet NSIS archive lacks resources/app.asar.");
  const extracted = commandRunner("tar.exe", ["-xf", installer, "-C", runtimeRoot], { encoding: "utf8", timeout: 900_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(extracted.status, 0, extracted.error?.message || extracted.stderr || "Unable to extract the BrainPet NSIS archive.");
}

function validateSourceRun(run, expected) {
  assert.equal(String(run.id), expected.runId);
  assert.equal(String(run.path).split("@")[0], brainPetPublicReleaseWorkflow.path, "Prepared candidate came from the wrong workflow file.");
  assert.equal(run.name, brainPetPublicReleaseWorkflow.name, "Prepared candidate came from the wrong workflow name.");
  assert.equal(run.head_sha.toLowerCase(), expected.sourceCommit.toLowerCase(), "Prepared candidate workflow ran against a different commit.");
  assert.equal(run.conclusion, "success", "Prepared candidate workflow did not succeed.");
  assert.equal(run.event, brainPetPublicReleaseWorkflow.trigger, "Prepared candidate workflow used the wrong trigger.");
  assert.equal(run.repository?.full_name, expected.repository);
  assert.ok(Number.isInteger(Number(run.run_attempt)) && Number(run.run_attempt) > 0, "Prepared candidate run attempt is invalid.");
}

function validateAggregateCandidate(receipt, packageReceipt, expected) {
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.product, "brainpet");
  assert.equal(receipt.appId, brainPetDistributionContract.identity.appId);
  assert.equal(receipt.releaseMode, "public-release");
  assert.equal(receipt.sourceCommit.toLowerCase(), expected.sourceCommit.toLowerCase());
  assert.equal(String(receipt.sourceRunId), expected.runId);
  assert.equal(String(receipt.sourceRunAttempt), String(expected.runAttempt));
  assert.equal(receipt.rc6GatePassed, true);
  assert.equal(receipt.publicReleaseReady, false);
  assert.match(receipt.physicalChallenge ?? "", /^[a-f0-9]{64}$/i);
  assert.deepEqual([...receipt.missingEvidence].sort(), ["macos-arm64:physical-acceptance", "performance:active-30m", "performance:idle-24h", "windows-x64:physical-acceptance"].sort());
  assert.ok(Array.isArray(receipt.packages) && receipt.packages.length === brainPetReleaseTargets.length);
  assert.deepEqual(receipt.packages.find((entry) => entry.target === "windows-x64"), { ...packageReceipt, provenanceValidated: true }, "Public aggregate and Windows package receipt differ.");
  const { evidenceDigest, generatedAt: _generatedAt, ...core } = receipt;
  assert.equal(evidenceDigest, sha256Bytes(Buffer.from(JSON.stringify(core))), "Public aggregate candidate digest is invalid.");
}

function createProvenanceRecord(subject, subjectPath, downloadedProvenanceRoot, provenanceRoot, outputRoot) {
  const subjectSha256 = sha256(subjectPath);
  const bundleName = `sha256-${subjectSha256}.sigstore.json`;
  const downloadedBundlePath = join(downloadedProvenanceRoot, bundleName);
  assertRegularFile(downloadedBundlePath, `BrainPet ${subject} provenance bundle`, 2 * 1024 * 1024);
  assert.doesNotThrow(() => JSON.parse(readFileSync(downloadedBundlePath, "utf8")), `BrainPet ${subject} provenance bundle is not JSON.`);
  const bundlePath = join(provenanceRoot, bundleName);
  copyFileSync(downloadedBundlePath, bundlePath, fsConstants.COPYFILE_EXCL);
  assertRegularFile(bundlePath, `Selected BrainPet ${subject} provenance bundle`, 2 * 1024 * 1024);
  return { subject, subjectSha256, bundle: toPortableRelative(outputRoot, bundlePath), bundleSha256: sha256(bundlePath) };
}

function validateDownloadedProvenanceDirectory(provenanceRoot) {
  assertDirectory(provenanceRoot, "BrainPet provenance directory");
  const entries = readdirSync(provenanceRoot, { withFileTypes: true });
  assert.ok(entries.length > 0, "BrainPet provenance directory is empty.");
  for (const entry of entries) {
    assert.ok(entry.isFile() && !entry.isSymbolicLink(), `BrainPet provenance contains an unsafe entry: ${entry.name}`);
    assert.match(entry.name, /^sha256-[a-f0-9]{64}\.sigstore\.json$/i, `BrainPet provenance contains an unexpected file: ${entry.name}`);
    readJson(join(provenanceRoot, entry.name), `BrainPet provenance ${entry.name}`);
  }
}

function validateSelectedProvenanceDirectory(provenanceRoot, expectedNames) {
  assertDirectory(provenanceRoot, "Selected BrainPet provenance directory");
  const actualNames = readdirSync(provenanceRoot, { withFileTypes: true }).map((entry) => {
    assert.ok(entry.isFile() && !entry.isSymbolicLink(), `Selected BrainPet provenance contains an unsafe entry: ${entry.name}`);
    return entry.name;
  }).sort();
  assert.deepEqual(actualNames, [...expectedNames].sort(), "Selected BrainPet provenance closure is incomplete or contains an extra file.");
}

function assertExtractedRuntimeIsSafe(runtimeRoot) {
  const realRoot = realpathSync.native(runtimeRoot);
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, `Extracted BrainPet runtime contains a symbolic link or junction: ${path}`);
      const realChild = relative(realRoot, realpathSync.native(path));
      assert.ok(realChild && !realChild.startsWith("..") && !isAbsolute(realChild), `Extracted BrainPet runtime escaped its root: ${path}`);
      if (entry.isDirectory()) visit(path);
      else assert.ok(entry.isFile(), `Extracted BrainPet runtime contains an unsupported entry: ${path}`);
    }
  };
  visit(runtimeRoot);
}

function assertPortableArchiveEntry(entry) {
  assert.ok(entry.length > 0 && entry.length <= 4096 && !entry.includes("\\") && !entry.includes("\0") && !entry.includes(":"), `BrainPet NSIS archive path is invalid: ${entry}`);
  assert.equal(entry.startsWith("/"), false, `BrainPet NSIS archive path is absolute: ${entry}`);
  const segments = entry.replace(/\/$/, "").split("/");
  assert.ok(segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), `BrainPet NSIS archive path is unsafe: ${entry}`);
}

function resolveGitHubRun({ repository, runId }) {
  return JSON.parse(runGh(["api", `repos/${repository}/actions/runs/${runId}`]).stdout);
}

function downloadGitHubArtifact({ repository, runId, name, destination }) {
  runGh(["run", "download", runId, "--repo", repository, "--name", name, "--dir", destination], 900_000);
}

function runGh(args, timeout = 120_000) {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || `gh ${args.join(" ")} failed.`);
  return result;
}

function resolveGitCommit(repoRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || "Unable to resolve the BrainPet source commit.");
  return result.stdout.trim();
}

function assertExactEntries(directory, expected, label) {
  assertDirectory(directory, `${label} is missing.`);
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) assert.ok(entry.isFile() && !entry.isSymbolicLink(), `${label} contains an unsafe entry: ${entry.name}`);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [...expected].sort(), `${label} is incomplete or contains an extra file.`);
}

function readJson(path, label) {
  assertRegularFile(path, label, 2 * 1024 * 1024);
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertRegularFile(path, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximumBytes, `${label} is missing, unsafe, or oversized.`);
}

function assertDirectory(path, label) {
  const stat = existsSync(path) ? lstatSync(path) : null;
  assert.ok(stat?.isDirectory() && !stat.isSymbolicLink(), `${label} is missing or unsafe.`);
}

function assertUnderRoot(path, root, label) {
  const child = relative(resolve(root), resolve(path));
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child), `${label} escaped its allowed root.`);
}

function toPortableRelative(root, path) {
  assertUnderRoot(path, root, "Prepared BrainPet candidate path");
  return relative(root, path).replaceAll("\\", "/");
}

function sha256(path) {
  return sha256Bytes(readFileSync(path));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run-id") options.runId = argv[++index];
    else if (argv[index] === "--output") options.outputRoot = argv[++index];
    else if (argv[index] === "--commit") options.sourceCommit = argv[++index];
    else throw new Error(`Unknown BrainPet performance-candidate argument: ${argv[index]}`);
  }
  assert.ok(options.runId, "Usage: prepare-brainpet-public-performance-candidate.mjs --run-id <successful-public-run> [--commit <sha>] [--output <new-dir>]");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const prepared = prepareBrainPetPublicPerformanceCandidate(parseArgs(process.argv.slice(2)));
    console.log(`BrainPet public performance candidate prepared (${prepared.candidate.commit}, run ${prepared.candidate.sourceRunId}).`);
    console.log(prepared.manifestPath);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
