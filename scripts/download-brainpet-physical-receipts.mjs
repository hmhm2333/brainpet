#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "./brainpet-release-contract.mjs";
import { validateBrainPetPhysicalReceiptSet } from "./brainpet-physical-receipt-contract.mjs";
import { brainPetPhysicalReceiptWorkflow, brainPetSigstoreBundlePath, verifyBrainPetSigstoreSubject } from "./brainpet-sigstore-provenance.mjs";
import { formatBrainPetPhysicalApprovalComment, validateEnvironmentApprovalHistory } from "./intake-brainpet-physical-receipts.mjs";

export function downloadBrainPetPhysicalReceipts(options) {
  assert.match(options.runId ?? "", /^\d{1,20}$/, "Physical receipt run id is invalid.");
  assert.match(options.sourceCommit ?? "", /^[a-f0-9]{40}$/i, "Physical receipt download requires an exact source commit.");
  assert.equal(options.repository, brainPetDistributionContract.identity.repository, "Physical receipt download repository is invalid.");
  const outputRoot = resolve(options.outputRoot);
  assert.equal(existsSync(outputRoot), false, `Physical receipt download output already exists: ${outputRoot}`);

  const run = JSON.parse(runGh(["api", `repos/${options.repository}/actions/runs/${options.runId}`]).stdout);
  assert.equal(String(run.id), options.runId);
  assert.equal(String(run.path).split("@")[0], brainPetPhysicalReceiptWorkflow.path, "Physical receipt artifact came from the wrong workflow file.");
  assert.equal(run.head_sha.toLowerCase(), options.sourceCommit.toLowerCase(), "Physical receipt workflow ran against a different commit.");
  assert.equal(run.conclusion, "success", "Physical receipt intake workflow did not succeed.");
  assert.equal(run.event, "workflow_dispatch", "Physical receipt intake must be manually dispatched.");
  assert.equal(run.repository?.full_name, options.repository);
  assert.equal(String(run.run_attempt), "1", "Physical receipt intake reruns are forbidden; create a new workflow dispatch.");
  const runActor = run.actor?.login;
  assert.ok(typeof runActor === "string" && runActor.length > 0, "Physical receipt workflow lacks an authenticated dispatcher.");
  const approvalHistory = JSON.parse(runGh(["api", `repos/${options.repository}/actions/runs/${options.runId}/approvals`]).stdout);
  runGh(["run", "download", options.runId, "--repo", options.repository, "--name", "brainpet-physical-receipts", "--dir", outputRoot]);

  assertExactEntries(outputRoot, ["physical", "provenance"]);
  const physicalRoot = join(outputRoot, "physical");
  const provenanceRoot = join(outputRoot, "provenance");
  assertExactEntries(physicalRoot, ["brainpet-physical-intake.json", "macos-arm64", "windows-x64"]);
  assertExactEntries(join(physicalRoot, "windows-x64"), ["brainpet-physical-receipt.json"]);
  assertExactEntries(join(physicalRoot, "macos-arm64"), ["brainpet-physical-receipt.json"]);

  const candidatePath = resolve(options.candidateReceiptPath);
  const candidate = readJson(candidatePath);
  assert.equal(candidate.sourceCommit.toLowerCase(), options.sourceCommit.toLowerCase(), "Physical receipt candidate commit is invalid.");
  assert.match(String(candidate.sourceRunId ?? ""), /^\d{1,20}$/, "Physical receipt candidate run id is invalid.");
  assert.match(candidate.physicalChallenge ?? "", /^[a-f0-9]{64}$/i, "Physical receipt candidate challenge is invalid.");
  const expectedCandidate = { runId: String(candidate.sourceRunId), receiptSha256: sha256(candidatePath), challenge: candidate.physicalChallenge.toLowerCase() };
  const intakePath = join(physicalRoot, "brainpet-physical-intake.json");
  const intake = readJson(intakePath);
  assert.equal(intake.schemaVersion, 2, "Physical intake schema is invalid.");
  assert.equal(intake.product, "brainpet");
  assert.equal(intake.repository, options.repository);
  assert.equal(intake.sourceCommit.toLowerCase(), options.sourceCommit.toLowerCase());
  assert.deepEqual(intake.candidate, expectedCandidate, "Physical intake references the wrong public candidate.");
  assert.ok(typeof intake.github?.actor === "string" && intake.github.actor.length > 0, "Physical intake lacks an authenticated workflow dispatcher.");
  assert.equal(intake.github.environment, "brainpet-physical-acceptance");
  assert.ok(typeof intake.github.environmentReviewer === "string" && intake.github.environmentReviewer.length > 0, "Physical intake lacks an authenticated environment reviewer.");
  assert.match(intake.github.receiptsPayloadSha256 ?? "", /^[a-f0-9]{64}$/i, "Physical intake lacks the approved receipt-payload digest.");
  const expectedApprovalComment = formatBrainPetPhysicalApprovalComment(expectedCandidate, intake.github.receiptsPayloadSha256);
  assert.equal(intake.github.environmentApprovalComment, expectedApprovalComment, "Physical intake manifest contains the wrong approval comment.");
  const environmentReviewer = validateEnvironmentApprovalHistory(approvalHistory, runActor, expectedApprovalComment);
  assert.equal(intake.github.environmentReviewer, environmentReviewer, "Physical intake reviewer does not match GitHub approval history.");
  assert.equal(intake.github.actor, runActor, "Physical intake dispatcher does not match the workflow run actor.");
  assert.equal(String(intake.github.runId), options.runId, "Physical intake manifest came from a different workflow run.");
  assert.equal(String(intake.github.runAttempt), String(run.run_attempt), "Physical intake manifest came from a different workflow run attempt.");
  assert.equal(intake.github.workflow, brainPetPhysicalReceiptWorkflow.name);
  assert.equal(intake.github.runnerEnvironment, "github-hosted");

  const receiptPaths = [join(physicalRoot, "windows-x64", "brainpet-physical-receipt.json"), join(physicalRoot, "macos-arm64", "brainpet-physical-receipt.json")];
  const receipts = receiptPaths.map((path) => readJson(path));
  const validated = validateBrainPetPhysicalReceiptSet(receipts, { expectedSourceCommit: options.sourceCommit, expectedCandidate, expectedReviewer: intake.github.environmentReviewer });
  for (let index = 0; index < validated.length; index += 1) {
    const receipt = validated[index];
    const path = receiptPaths[index];
    const intakeTarget = intake.targets.find((target) => target.target === receipt.target);
    assert.equal(intakeTarget?.artifactSha256, receipt.artifactSha256, `Physical intake artifact hash mismatch for ${receipt.target}.`);
    verifyPhysicalProvenance(path, provenanceRoot, options);
  }
  verifyPhysicalProvenance(intakePath, provenanceRoot, options);
  const expectedBundles = [...receiptPaths, intakePath].map((path) => basename(brainPetSigstoreBundlePath(provenanceRoot, sha256(path))));
  assertExactEntries(provenanceRoot, expectedBundles);
  return { runId: options.runId, sourceCommit: options.sourceCommit, candidateRunId: expectedCandidate.runId, physicalRoot, provenanceRoot, targets: validated.map((receipt) => receipt.target).sort() };
}

function verifyPhysicalProvenance(subjectPath, provenanceRoot, options) {
  const verifier = options.provenanceVerifier ?? verifyBrainPetSigstoreSubject;
  verifier({ subjectPath, bundlesRoot: provenanceRoot, repository: options.repository, workflowPath: brainPetPhysicalReceiptWorkflow.path, workflowName: brainPetPhysicalReceiptWorkflow.name, sourceCommit: options.sourceCommit, label: basename(subjectPath) });
}

function assertExactEntries(directory, expectedNames) {
  const stat = existsSync(directory) ? lstatSync(directory) : null;
  assert.ok(stat?.isDirectory() && !stat.isSymbolicLink(), `Physical evidence directory is missing or unsafe: ${directory}`);
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) assert.equal(entry.isSymbolicLink(), false, `Physical evidence contains a symbolic link: ${entry.name}`);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [...expectedNames].sort(), `Physical evidence contains an unexpected entry in ${directory}.`);
}

function readJson(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, `Physical receipt is unsafe or oversized: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function runGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 60_000, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr || `gh ${args.join(" ")} failed.`);
  return result;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArgs(argv) {
  const options = { repository: process.env.GITHUB_REPOSITORY, sourceCommit: process.env.GITHUB_SHA };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run-id") options.runId = argv[++index];
    else if (argv[index] === "--candidate-receipt") options.candidateReceiptPath = argv[++index];
    else if (argv[index] === "--output") options.outputRoot = argv[++index];
    else throw new Error(`Unknown physical receipt download argument: ${argv[index]}`);
  }
  assert.ok(options.runId && options.candidateReceiptPath && options.outputRoot, "Usage: download-brainpet-physical-receipts.mjs --run-id <id> --candidate-receipt <signed-candidate.json> --output <dir>");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Physical receipt artifact download is restricted to GitHub Actions.");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "Physical receipt artifact download requires a GitHub-hosted runner.");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = downloadBrainPetPhysicalReceipts(parseArgs(process.argv.slice(2)));
    console.log(`BrainPet physical receipt artifact verified (run ${receipt.runId}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
