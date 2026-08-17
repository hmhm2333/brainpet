#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "./brainpet-release-contract.mjs";
import { validateBrainPetPerformanceReceiptSet } from "./brainpet-performance-release-contract.mjs";
import { brainPetPerformanceReceiptWorkflow, brainPetSigstoreBundlePath, verifyBrainPetSigstoreSubject } from "./brainpet-sigstore-provenance.mjs";
import { formatBrainPetPerformanceApprovalComment } from "./intake-brainpet-performance-receipts.mjs";
import { validateEnvironmentApprovalHistory } from "./intake-brainpet-physical-receipts.mjs";
import { validateBrainPetPackageArtifactClosure } from "./stage-brainpet-package-artifacts.mjs";

export function downloadBrainPetPerformanceReceipts(options) {
  assert.match(options.runId ?? "", /^\d{1,20}$/);
  assert.match(options.sourceCommit ?? "", /^[a-f0-9]{40}$/i);
  assert.equal(options.repository, brainPetDistributionContract.identity.repository);
  const outputRoot = resolve(options.outputRoot);
  assert.equal(existsSync(outputRoot), false, `Performance receipt output already exists: ${outputRoot}`);
  const invokeGh = options.runGh ?? runGh;
  const provenanceVerifier = options.provenanceVerifier ?? verifyBrainPetSigstoreSubject;
  const run = JSON.parse(invokeGh(["api", `repos/${options.repository}/actions/runs/${options.runId}`]).stdout);
  assert.equal(String(run.id), options.runId);
  assert.equal(String(run.path).split("@")[0], brainPetPerformanceReceiptWorkflow.path);
  assert.equal(run.head_sha.toLowerCase(), options.sourceCommit.toLowerCase());
  assert.equal(run.conclusion, "success");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.repository?.full_name, options.repository);
  assert.equal(String(run.run_attempt), "1");
  const actor = run.actor?.login;
  assert.ok(typeof actor === "string" && actor.length > 0);
  const approvals = JSON.parse(invokeGh(["api", `repos/${options.repository}/actions/runs/${options.runId}/approvals`]).stdout);
  invokeGh(["run", "download", options.runId, "--repo", options.repository, "--name", "brainpet-performance-receipts", "--dir", outputRoot]);
  assertExactEntries(outputRoot, ["performance", "provenance"]);
  const performanceRoot = join(outputRoot, "performance");
  const provenanceRoot = join(outputRoot, "provenance");
  assertExactEntries(performanceRoot, ["brainpet-active-30m.json", "brainpet-idle-24h.json", "brainpet-performance-intake.json"]);

  const candidatePath = resolve(options.candidateReceiptPath);
  const candidateBytes = readRegular(candidatePath);
  const candidate = JSON.parse(candidateBytes.toString("utf8"));
  const windowsPackage = candidate.packages?.find((entry) => entry.target === "windows-x64");
  assert.ok(windowsPackage);
  const candidateReceiptSha256 = sha256(candidateBytes);
  const packageClosure = validateBrainPetPackageArtifactClosure(resolve(options.candidatePackageRoot), "windows-x64");
  assert.deepEqual(windowsPackage, { ...packageClosure.receipt, provenanceValidated: true }, "Performance download Windows package differs from the official candidate receipt.");
  const candidateBundlePath = brainPetSigstoreBundlePath(resolve(options.candidateProvenanceRoot), candidateReceiptSha256);
  const expectedCandidate = {
    runId: String(candidate.sourceRunId),
    receiptSha256: candidateReceiptSha256,
    challenge: candidate.physicalChallenge.toLowerCase(),
    packageReceiptSha256: sha256(readRegular(packageClosure.receiptPath)),
    provenanceBundleSha256: sha256(readRegular(candidateBundlePath)),
  };
  const intakePath = join(performanceRoot, "brainpet-performance-intake.json");
  const intake = JSON.parse(readRegular(intakePath).toString("utf8"));
  assert.equal(intake.schemaVersion, 1);
  assert.equal(intake.kind, "brainpet-performance-intake");
  assert.equal(intake.repository, options.repository);
  assert.equal(intake.sourceCommit.toLowerCase(), options.sourceCommit.toLowerCase());
  assert.deepEqual(intake.candidate, expectedCandidate);
  assert.equal(intake.github.workflow, brainPetPerformanceReceiptWorkflow.name);
  assert.equal(intake.github.environment, "brainpet-physical-acceptance");
  assert.equal(String(intake.github.runId), options.runId);
  assert.equal(String(intake.github.runAttempt), "1");
  assert.equal(intake.github.actor, actor);
  assert.equal(intake.github.runnerEnvironment, "github-hosted");
  const expectedComment = formatBrainPetPerformanceApprovalComment(expectedCandidate, intake.github.payloadSha256);
  assert.equal(intake.github.environmentApprovalComment, expectedComment);
  const reviewer = validateEnvironmentApprovalHistory(approvals, actor, expectedComment);
  assert.equal(intake.github.environmentReviewer, reviewer);

  const receiptPaths = [join(performanceRoot, "brainpet-active-30m.json"), join(performanceRoot, "brainpet-idle-24h.json")];
  const receipts = validateBrainPetPerformanceReceiptSet(receiptPaths.map((path) => JSON.parse(readRegular(path).toString("utf8"))), {
    sourceCommit: options.sourceCommit,
    packageReceipt: windowsPackage,
    packageReceiptSha256: expectedCandidate.packageReceiptSha256,
    publicCandidateReceiptSha256: expectedCandidate.receiptSha256,
    provenanceBundleSha256: expectedCandidate.provenanceBundleSha256,
  });
  for (const receipt of receipts) {
    const path = join(performanceRoot, `brainpet-${receipt.gateProfile}.json`);
    assert.equal(intake.profiles.find((entry) => entry.gateProfile === receipt.gateProfile)?.receiptSha256, sha256(readRegular(path)));
    verifyProvenance(path, provenanceRoot, options, provenanceVerifier);
  }
  verifyProvenance(intakePath, provenanceRoot, options, provenanceVerifier);
  const expectedBundles = [...receiptPaths, intakePath].map((path) => basename(brainPetSigstoreBundlePath(provenanceRoot, sha256(readRegular(path)))));
  assertExactEntries(provenanceRoot, expectedBundles);
  return { performanceRoot, provenanceRoot, receipts, intake };
}

function verifyProvenance(path, provenanceRoot, options, provenanceVerifier) {
  provenanceVerifier({ subjectPath: path, bundlesRoot: provenanceRoot, repository: options.repository, workflowPath: brainPetPerformanceReceiptWorkflow.path, workflowName: brainPetPerformanceReceiptWorkflow.name, sourceCommit: options.sourceCommit, label: basename(path) });
}

function assertExactEntries(directory, expected) {
  const stat = existsSync(directory) ? lstatSync(directory) : null;
  assert.ok(stat?.isDirectory() && !stat.isSymbolicLink());
  const entries = readdirSync(directory, { withFileTypes: true });
  assert.ok(entries.every((entry) => !entry.isSymbolicLink()));
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [...expected].sort());
}

function readRegular(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 16 * 1024 * 1024);
  return readFileSync(path);
}

function runGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 120_000, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr || `gh ${args.join(" ")} failed.`);
  return result;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function parseArgs(argv) {
  const options = { repository: process.env.GITHUB_REPOSITORY, sourceCommit: process.env.GITHUB_SHA };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run-id") options.runId = argv[++index];
    else if (argv[index] === "--candidate-receipt") options.candidateReceiptPath = argv[++index];
    else if (argv[index] === "--candidate-package") options.candidatePackageRoot = argv[++index];
    else if (argv[index] === "--candidate-provenance") options.candidateProvenanceRoot = argv[++index];
    else if (argv[index] === "--output") options.outputRoot = argv[++index];
    else throw new Error(`Unknown performance download argument: ${argv[index]}`);
  }
  assert.ok(options.runId && options.candidateReceiptPath && options.candidatePackageRoot && options.candidateProvenanceRoot && options.outputRoot);
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = downloadBrainPetPerformanceReceipts(parseArgs(process.argv.slice(2))); console.log(`BrainPet performance receipts verified (${result.receipts.length}).`); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
