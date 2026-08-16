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
  const approvalComment = options.approvalHistoryPath
    ? createBrainPetPhysicalApprovalComment(expectedCandidate, options.payload)
    : null;
  const expectedReviewer = options.approvalHistoryPath
    ? validateEnvironmentApproval(options.approvalHistoryPath, authenticatedActor, approvalComment)
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
  const identity = {
    ...(options.identity ?? {
      workflow: process.env.GITHUB_WORKFLOW ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      actor: process.env.GITHUB_ACTOR ?? null,
      environment: "brainpet-physical-acceptance",
      runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
    }),
    environmentReviewer: expectedReviewer,
    environmentApprovalComment: approvalComment,
    receiptsPayloadSha256: options.payload ? sha256Text(options.payload) : null,
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

export function createBrainPetPhysicalApprovalComment(candidate, receiptsPayload) {
  assert.ok(typeof receiptsPayload === "string" && receiptsPayload.length > 0, "Physical intake approval requires the exact receipts payload.");
  return formatBrainPetPhysicalApprovalComment(candidate, sha256Text(receiptsPayload));
}

export function formatBrainPetPhysicalApprovalComment(candidate, receiptsPayloadSha256) {
  assert.match(String(candidate?.runId ?? ""), /^\d{1,20}$/, "Physical approval candidate run id is invalid.");
  assert.match(candidate?.receiptSha256 ?? "", /^[a-f0-9]{64}$/i, "Physical approval candidate receipt digest is invalid.");
  assert.match(candidate?.challenge ?? "", /^[a-f0-9]{64}$/i, "Physical approval candidate challenge is invalid.");
  assert.match(receiptsPayloadSha256 ?? "", /^[a-f0-9]{64}$/i, "Physical approval payload digest is invalid.");
  return `brainpet-physical-acceptance-v1 candidate-run=${candidate.runId} candidate-receipt-sha256=${candidate.receiptSha256.toLowerCase()} challenge=${candidate.challenge.toLowerCase()} receipts-payload-sha256=${receiptsPayloadSha256.toLowerCase()}`;
}

export function validateEnvironmentApproval(path, authenticatedActor, expectedComment) {
  return validateEnvironmentApprovalHistory(readReceipt(path), authenticatedActor, expectedComment);
}

export function validateEnvironmentApprovalHistory(approvals, authenticatedActor, expectedComment) {
  assert.ok(typeof authenticatedActor === "string" && authenticatedActor.length > 0, "Physical intake lacks an authenticated workflow actor.");
  assert.ok(typeof expectedComment === "string" && expectedComment.length > 0, "Physical intake lacks the exact approval comment contract.");
  assert.ok(Array.isArray(approvals), "Physical intake approval history must be an array.");
  const approved = approvals.filter((approval) => approval?.state === "approved" && Array.isArray(approval.environments) && approval.environments.some((environment) => environment?.name === "brainpet-physical-acceptance"));
  assert.equal(approved.length, 1, "Physical intake requires exactly one approved brainpet-physical-acceptance environment review; reruns require a new workflow dispatch.");
  assert.equal(approved[0].comment, expectedComment, "Physical intake approval comment does not bind the exact candidate and receipt payload.");
  const reviewer = approved[0].user?.login;
  assert.ok(typeof reviewer === "string" && reviewer.length > 0, "Physical intake approval lacks a GitHub reviewer identity.");
  assert.notEqual(reviewer.toLowerCase(), authenticatedActor.toLowerCase(), "Physical intake environment approval must not be a self-review.");
  return reviewer;
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
    else if (arg === "--emit-dispatch-envelope") options.emitDispatchEnvelope = true;
    else if (arg === "--require-trusted-ci") options.requireTrustedCi = true;
    else throw new Error(`Unknown physical intake argument: ${arg}`);
  }
  assert.ok(options.payload || options.receiptPaths.length > 0, "Physical intake requires receipt files or a JSON payload.");
  assert.ok(options.candidateReceiptPath, "Physical intake requires the signed public candidate receipt.");
  if (options.requireTrustedCi) {
    assert.equal(options.expectedReviewer, undefined, "Trusted CI derives the reviewer from GitHub environment approval history.");
    assert.ok(options.approvalHistoryPath, "Trusted CI requires the current workflow run approval history.");
    assert.ok(options.payload, "Trusted CI requires the exact workflow_dispatch receipt payload.");
    assert.equal(process.env.GITHUB_ACTIONS, "true", "Physical receipt intake is restricted to GitHub Actions.");
    assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "Physical receipt intake requires a GitHub-hosted runner.");
    assert.equal(process.env.GITHUB_WORKFLOW, "BrainPet physical receipt intake", "Physical receipts must enter through the dedicated intake workflow.");
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1", "Physical receipt intake reruns are forbidden; create a new workflow dispatch.");
  }
  assert.ok(!options.emitDispatchEnvelope || !options.outputRoot, "Dispatch-envelope mode writes only to stdout.");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const receipts = intakeBrainPetPhysicalReceipts(options);
    if (options.emitDispatchEnvelope) {
      const receiptsJson = JSON.stringify(receipts);
      console.log(JSON.stringify({ candidateRunId: receipts[0].candidate.runId, receiptsJson, approvalComment: createBrainPetPhysicalApprovalComment(receipts[0].candidate, receiptsJson) }));
    } else if (!options.outputRoot) console.log(JSON.stringify(receipts));
    else console.log(`BrainPet physical receipts accepted (${receipts.map((receipt) => receipt.target).join(", ")}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
