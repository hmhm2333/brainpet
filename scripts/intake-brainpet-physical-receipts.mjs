#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createBrainPetPhysicalIntake, validateBrainPetPhysicalReceiptSet } from "./brainpet-physical-receipt-contract.mjs";

export function intakeBrainPetPhysicalReceipts(options) {
  const expectedSourceCommit = options.expectedSourceCommit ?? process.env.GITHUB_SHA;
  assert.match(expectedSourceCommit ?? "", /^[a-f0-9]{40}$/i, "Physical intake requires an exact source commit.");
  assert.ok(options.candidateReceiptPath, "Physical intake requires the signed public candidate receipt.");
  const candidatePath = resolve(options.candidateReceiptPath);
  const candidateReceipt = readReceipt(candidatePath);
  assert.equal(candidateReceipt.schemaVersion, 2, "Physical intake candidate receipt schema is invalid.");
  assert.equal(candidateReceipt.product, "brainpet", "Physical intake candidate product is invalid.");
  assert.equal(candidateReceipt.releaseMode, "public-release", "Physical intake requires a public-release candidate.");
  assert.equal(candidateReceipt.rc6GatePassed, true, "Physical intake candidate did not pass RC6.");
  assert.equal(candidateReceipt.publicReleaseReady, false, "Physical intake must precede public readiness.");
  assert.equal(candidateReceipt.sourceCommit.toLowerCase(), expectedSourceCommit.toLowerCase(), "Physical intake candidate commit is invalid.");
  assert.match(String(candidateReceipt.sourceRunId ?? ""), /^\d{1,20}$/, "Physical intake candidate run id is invalid.");
  assert.match(candidateReceipt.physicalChallenge ?? "", /^[a-f0-9]{64}$/i, "Physical intake candidate challenge is invalid.");
  const expectedCandidate = {
    runId: String(candidateReceipt.sourceRunId),
    receiptSha256: createHash("sha256").update(readFileSync(candidatePath)).digest("hex"),
    challenge: candidateReceipt.physicalChallenge.toLowerCase(),
  };
  if (options.payload) assert.ok(options.payload.length <= 128 * 1024, "Physical receipt payload is oversized.");
  const receipts = options.payload
    ? JSON.parse(options.payload)
    : options.receiptPaths.map((path) => readReceipt(path));
  const authenticatedActor = options.authenticatedActor ?? process.env.GITHUB_ACTOR;
  const expectedReviewer = options.approvalHistoryPath
    ? validateEnvironmentApproval(options.approvalHistoryPath, authenticatedActor)
    : options.expectedReviewer;
  assert.ok(typeof expectedReviewer === "string" && expectedReviewer.length > 0, "Physical intake requires an authenticated reviewer identity.");
  const validated = validateBrainPetPhysicalReceiptSet(receipts, { expectedSourceCommit, expectedCandidate, expectedReviewer });
  if (!options.outputRoot) return validated;

  const outputRoot = resolve(options.outputRoot);
  assert.equal(existsSync(outputRoot), false, `Physical intake output already exists: ${outputRoot}`);
  mkdirSync(outputRoot, { recursive: true });
  for (const receipt of validated) {
    const targetRoot = join(outputRoot, receipt.target);
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(join(targetRoot, "brainpet-physical-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  const identity = options.identity ?? {
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    actor: process.env.GITHUB_ACTOR ?? null,
    environment: "brainpet-physical-acceptance",
    environmentReviewer: expectedReviewer,
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
  };
  assert.equal(identity.environmentReviewer, expectedReviewer, "Physical intake identity does not match the authenticated environment reviewer.");
  const intake = createBrainPetPhysicalIntake(validated, identity);
  const receiptDigest = createHash("sha256").update(JSON.stringify(validated)).digest("hex");
  writeFileSync(join(outputRoot, "brainpet-physical-intake.json"), `${JSON.stringify({ ...intake, receiptDigest }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return validated;
}

function readReceipt(path) {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, `Physical receipt file is unsafe or oversized: ${resolved}`);
  return JSON.parse(readFileSync(resolved, "utf8").replace(/^\uFEFF/, ""));
}

export function validateEnvironmentApproval(path, authenticatedActor) {
  return validateEnvironmentApprovalHistory(readReceipt(path), authenticatedActor);
}

export function validateEnvironmentApprovalHistory(approvals, authenticatedActor) {
  assert.ok(typeof authenticatedActor === "string" && authenticatedActor.length > 0, "Physical intake lacks an authenticated workflow actor.");
  assert.ok(Array.isArray(approvals), "Physical intake approval history must be an array.");
  const reviewers = approvals
    .filter((approval) => approval?.state === "approved" && approval.environments?.some((environment) => environment?.name === "brainpet-physical-acceptance"))
    .map((approval) => approval.user?.login)
    .filter((login) => typeof login === "string" && login.length > 0);
  assert.equal(reviewers.length, 1, "Physical intake requires exactly one approved brainpet-physical-acceptance environment review.");
  assert.notEqual(reviewers[0].toLowerCase(), authenticatedActor.toLowerCase(), "Physical intake environment approval must not be a self-review.");
  return reviewers[0];
}

function parseArgs(argv) {
  const options = { receiptPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--receipt") options.receiptPaths.push(argv[++index]);
    else if (arg === "--candidate-receipt") options.candidateReceiptPath = argv[++index];
    else if (arg === "--payload-env") {
      const name = argv[++index];
      assert.match(name ?? "", /^BRAINPET_[A-Z0-9_]+$/, "Physical receipt environment variable name is invalid.");
      options.payload = process.env[name];
    } else if (arg === "--output") options.outputRoot = argv[++index];
    else if (arg === "--source-commit") options.expectedSourceCommit = argv[++index];
    else if (arg === "--expected-reviewer") options.expectedReviewer = argv[++index];
    else if (arg === "--approval-history") options.approvalHistoryPath = argv[++index];
    else if (arg === "--require-trusted-ci") options.requireTrustedCi = true;
    else throw new Error(`Unknown physical intake argument: ${arg}`);
  }
  assert.ok(options.payload || options.receiptPaths.length > 0, "Physical intake requires receipt files or a JSON payload.");
  assert.ok(options.candidateReceiptPath, "Physical intake requires the signed public candidate receipt.");
  if (options.requireTrustedCi) {
    assert.equal(options.expectedReviewer, undefined, "Trusted CI derives the reviewer from GitHub environment approval history.");
    assert.ok(options.approvalHistoryPath, "Trusted CI requires the current workflow run approval history.");
    assert.equal(process.env.GITHUB_ACTIONS, "true", "Physical receipt intake is restricted to GitHub Actions.");
    assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "Physical receipt intake requires a GitHub-hosted runner.");
    assert.equal(process.env.GITHUB_WORKFLOW, "BrainPet physical receipt intake", "Physical receipts must enter through the dedicated intake workflow.");
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipts = intakeBrainPetPhysicalReceipts(parseArgs(process.argv.slice(2)));
    if (!process.argv.includes("--output")) console.log(JSON.stringify(receipts));
    else console.log(`BrainPet physical receipts accepted (${receipts.map((receipt) => receipt.target).join(", ")}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
