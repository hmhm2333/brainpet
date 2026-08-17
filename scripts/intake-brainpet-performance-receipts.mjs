#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "./brainpet-release-contract.mjs";
import { validateBrainPetPerformanceReceiptSet } from "./brainpet-performance-release-contract.mjs";
import { brainPetSigstoreBundlePath } from "./brainpet-sigstore-provenance.mjs";
import { validateEnvironmentApproval } from "./intake-brainpet-physical-receipts.mjs";
import { validateBrainPetPackageArtifactClosure } from "./stage-brainpet-package-artifacts.mjs";

export function intakeBrainPetPerformanceReceipts(options) {
  const sourceCommit = options.sourceCommit ?? process.env.GITHUB_SHA;
  assert.match(sourceCommit ?? "", /^[a-f0-9]{40}$/i, "Performance intake requires an exact source commit.");
  const candidatePath = resolve(options.candidateReceiptPath ?? "");
  const candidateBytes = readRegularFile(candidatePath, 2 * 1024 * 1024, "public candidate receipt");
  const candidateReceipt = JSON.parse(candidateBytes.toString("utf8"));
  assert.equal(candidateReceipt.schemaVersion, 2);
  assert.equal(candidateReceipt.product, "brainpet");
  assert.equal(candidateReceipt.releaseMode, "public-release");
  assert.equal(candidateReceipt.rc6GatePassed, true);
  assert.equal(candidateReceipt.publicReleaseReady, false);
  assert.equal(candidateReceipt.sourceCommit.toLowerCase(), sourceCommit.toLowerCase());
  assert.match(String(candidateReceipt.sourceRunId ?? ""), /^\d{1,20}$/);
  assert.match(candidateReceipt.physicalChallenge ?? "", /^[a-f0-9]{64}$/i);
  const publicWindowsPackage = candidateReceipt.packages?.find((entry) => entry.target === "windows-x64");
  assert.ok(publicWindowsPackage, "Performance intake candidate lacks the Windows x64 package.");
  const candidate = { runId: String(candidateReceipt.sourceRunId), receiptSha256: sha256(candidateBytes), challenge: candidateReceipt.physicalChallenge.toLowerCase() };
  const exactBindings = { publicCandidateReceiptSha256: candidate.receiptSha256 };
  assert.equal(Boolean(options.candidatePackageRoot), Boolean(options.candidateProvenanceRoot), "Performance intake requires both candidate package and provenance roots together.");
  if (options.candidatePackageRoot) {
    const closure = validateBrainPetPackageArtifactClosure(resolve(options.candidatePackageRoot), "windows-x64");
    assert.deepEqual(publicWindowsPackage, { ...closure.receipt, provenanceValidated: true }, "Performance intake Windows package differs from its official candidate receipt.");
    const candidateBundlePath = brainPetSigstoreBundlePath(resolve(options.candidateProvenanceRoot), candidate.receiptSha256);
    exactBindings.packageReceiptSha256 = sha256(readRegularFile(closure.receiptPath, 2 * 1024 * 1024, "candidate package receipt"));
    exactBindings.provenanceBundleSha256 = sha256(readRegularFile(candidateBundlePath, 2 * 1024 * 1024, "candidate Sigstore bundle"));
    candidate.packageReceiptSha256 = exactBindings.packageReceiptSha256;
    candidate.provenanceBundleSha256 = exactBindings.provenanceBundleSha256;
  }

  const payload = options.payload ?? createCompressedPayload(options.receiptPaths.map((path) => JSON.parse(readRegularFile(resolve(path), 16 * 1024 * 1024, "performance receipt").toString("utf8"))));
  assert.ok(typeof payload === "string" && payload.length > 0 && payload.length <= 60_000 && /^[A-Za-z0-9+/=]+$/.test(payload), "Performance receipt compressed payload is invalid or oversized.");
  const receipts = decodeCompressedPayload(payload);
  const validated = validateBrainPetPerformanceReceiptSet(receipts, { sourceCommit, packageReceipt: publicWindowsPackage, ...exactBindings });
  const approvalComment = formatBrainPetPerformanceApprovalComment(candidate, sha256Text(payload));
  const actor = options.actor ?? (options.identity ? options.identity.actor : process.env.GITHUB_ACTOR);
  const reviewer = options.approvalHistoryPath ? validateEnvironmentApproval(options.approvalHistoryPath, actor, approvalComment) : options.expectedReviewer;
  assert.ok(typeof reviewer === "string" && reviewer.length > 0, "Performance intake requires an authenticated reviewer.");
  if (!options.outputRoot) return { receipts: validated, candidate, payload, approvalComment, reviewer };

  const outputRoot = resolve(options.outputRoot);
  assert.equal(existsSync(outputRoot), false, `Performance intake output already exists: ${outputRoot}`);
  mkdirSync(outputRoot, { recursive: true });
  for (const receipt of validated) writeFileSync(join(outputRoot, `brainpet-${receipt.gateProfile}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const identity = options.identity ?? {
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    actor: process.env.GITHUB_ACTOR ?? null,
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
  };
  const github = {
    workflow: identity.workflow,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    actor: actor ?? identity.actor,
    environment: "brainpet-physical-acceptance",
    environmentReviewer: reviewer,
    environmentApprovalComment: approvalComment,
    runnerEnvironment: identity.runnerEnvironment,
    payloadSha256: sha256Text(payload),
  };
  const intake = {
    schemaVersion: 1,
    kind: "brainpet-performance-intake",
    product: "brainpet",
    repository: brainPetDistributionContract.identity.repository,
    sourceCommit: sourceCommit.toLowerCase(),
    candidate,
    github,
    profiles: validated.map((receipt) => ({ gateProfile: receipt.gateProfile, receiptSha256: sha256(Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)), runId: receipt.runEvidence.runId, completedAt: receipt.completedAt })),
  };
  writeFileSync(join(outputRoot, "brainpet-performance-intake.json"), `${JSON.stringify(intake, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { receipts: validated, candidate, payload, approvalComment, reviewer, intake };
}

export function createCompressedPayload(receipts) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(receipts), "utf8"), { level: 9, mtime: 0 });
  assert.ok(compressed.length <= 45_000, "Compressed BrainPet performance evidence exceeds the workflow-dispatch budget.");
  return compressed.toString("base64");
}

export function decodeCompressedPayload(payload) {
  const compressed = Buffer.from(payload, "base64");
  assert.ok(compressed.length > 0 && compressed.length <= 45_000, "Compressed BrainPet performance evidence is invalid or oversized.");
  const decoded = gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 });
  return JSON.parse(decoded.toString("utf8"));
}

export function formatBrainPetPerformanceApprovalComment(candidate, payloadSha256) {
  assert.match(String(candidate?.runId ?? ""), /^\d{1,20}$/);
  assert.match(candidate?.receiptSha256 ?? "", /^[a-f0-9]{64}$/i);
  assert.match(candidate?.challenge ?? "", /^[a-f0-9]{64}$/i);
  assert.match(payloadSha256 ?? "", /^[a-f0-9]{64}$/i);
  return `brainpet-performance-acceptance-v1 candidate-run=${candidate.runId} candidate-receipt-sha256=${candidate.receiptSha256.toLowerCase()} challenge=${candidate.challenge.toLowerCase()} receipts-payload-sha256=${payloadSha256.toLowerCase()}`;
}

function readRegularFile(path, maximumBytes, label) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximumBytes, `BrainPet ${label} is unsafe or oversized: ${path}`);
  return readFileSync(path);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function sha256Text(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

function parseArgs(argv) {
  const options = { receiptPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--receipt") options.receiptPaths.push(argv[++index]);
    else if (arg === "--candidate-receipt") options.candidateReceiptPath = argv[++index];
    else if (arg === "--candidate-package") options.candidatePackageRoot = argv[++index];
    else if (arg === "--candidate-provenance") options.candidateProvenanceRoot = argv[++index];
    else if (arg === "--payload-env") { const name = argv[++index]; assert.match(name ?? "", /^BRAINPET_[A-Z0-9_]+$/); options.payload = process.env[name]; }
    else if (arg === "--approval-history") options.approvalHistoryPath = argv[++index];
    else if (arg === "--expected-reviewer") options.expectedReviewer = argv[++index];
    else if (arg === "--source-commit") options.sourceCommit = argv[++index];
    else if (arg === "--output") options.outputRoot = argv[++index];
    else if (arg === "--emit-dispatch-envelope") options.emitDispatchEnvelope = true;
    else if (arg === "--require-trusted-ci") options.requireTrustedCi = true;
    else throw new Error(`Unknown performance intake argument: ${arg}`);
  }
  assert.ok(options.candidateReceiptPath && (options.payload || options.receiptPaths.length === 2), "Performance intake requires a candidate and exactly two receipt files or one compressed payload.");
  if (options.requireTrustedCi) {
    assert.ok(options.payload && options.approvalHistoryPath && options.outputRoot && options.candidatePackageRoot && options.candidateProvenanceRoot);
    assert.equal(process.env.GITHUB_ACTIONS, "true");
    assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
    assert.equal(process.env.GITHUB_WORKFLOW, "BrainPet performance receipt intake");
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1");
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = intakeBrainPetPerformanceReceipts(options);
    if (options.emitDispatchEnvelope) console.log(JSON.stringify({ candidateRunId: result.candidate.runId, receiptsGzipBase64: result.payload, approvalComment: result.approvalComment }));
    else console.log(`BrainPet performance receipts accepted (${result.receipts.map((receipt) => basename(`brainpet-${receipt.gateProfile}.json`)).join(", ")}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
