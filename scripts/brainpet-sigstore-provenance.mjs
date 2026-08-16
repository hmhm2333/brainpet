#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "./brainpet-release-contract.mjs";

export const brainPetPublicReleaseWorkflow = Object.freeze({
  name: "BrainPet public release gate",
  path: ".github/workflows/brainpet-public-release-gate.yml",
  trigger: "workflow_dispatch",
  oidcIssuer: "https://token.actions.githubusercontent.com",
});
export const brainPetPublicReleaseFinalizeWorkflow = Object.freeze({
  name: "BrainPet public release finalize",
  path: ".github/workflows/brainpet-public-release-finalize.yml",
  trigger: "workflow_dispatch",
  oidcIssuer: "https://token.actions.githubusercontent.com",
});
export const brainPetPhysicalReceiptWorkflow = Object.freeze({
  name: "BrainPet physical receipt intake",
  path: ".github/workflows/brainpet-physical-receipt-intake.yml",
  trigger: "workflow_dispatch",
  oidcIssuer: "https://token.actions.githubusercontent.com",
});
const trustedWorkflows = Object.freeze([brainPetPublicReleaseWorkflow, brainPetPublicReleaseFinalizeWorkflow, brainPetPhysicalReceiptWorkflow]);

export function signBrainPetReleaseEvidence(options) {
  const subjects = [];
  for (const receiptPath of findFiles(resolve(options.packagesRoot), /^brainpet-package-receipt-[a-z0-9-]+\.json$/)) {
    const receipt = readJson(receiptPath);
    assert.ok(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0, `Package receipt has no artifacts: ${receiptPath}`);
    const receiptRoot = dirname(receiptPath);
    subjects.push(receiptPath);
    for (const artifact of receipt.artifacts) {
      assert.ok(isRecord(artifact) && typeof artifact.path === "string" && /^[a-f0-9]{64}$/i.test(artifact.sha256), `Package artifact record is invalid: ${receiptPath}`);
      const subjectPath = resolveSafeRelative(receiptRoot, artifact.path);
      assertRegularFile(subjectPath, `Package artifact is unsafe: ${artifact.path}`);
      assert.equal(sha256(subjectPath), artifact.sha256.toLowerCase(), `Package artifact hash mismatch: ${artifact.path}`);
      subjects.push(subjectPath);
    }
  }
  subjects.push(...findFiles(resolve(options.lifecycleRoot), /^brainpet-install-lifecycle-receipt-[a-z0-9-]+-[a-z0-9-]+\.json$/));
  const bridgeReceipt = resolve(options.bridgeRoot, "brainpet-release.json");
  assertRegularFile(bridgeReceipt, "Bridge release receipt is missing or unsafe.");
  subjects.push(bridgeReceipt);
  return signBrainPetSubjects(subjects, options.bundlesRoot, options);
}

export function signBrainPetSubjects(subjects, bundlesRootArgument, options = {}) {
  const environment = options.environment ?? process.env;
  const workflow = assertTrustedSigningEnvironment(environment);
  assert.ok(Array.isArray(subjects) && subjects.length > 0, "At least one provenance subject is required.");
  const bundlesRoot = resolve(bundlesRootArgument);
  if (existsSync(bundlesRoot)) {
    const stat = lstatSync(bundlesRoot);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Provenance output is unsafe: ${bundlesRoot}`);
  } else {
    mkdirSync(bundlesRoot, { recursive: true });
  }
  const signer = options.signer ?? runCosignSign;
  const verifier = options.verifier ?? verifyBrainPetSigstoreSubject;
  const signed = [];
  for (const subjectPath of [...new Set(subjects.map((subject) => resolve(subject)))].sort()) {
    assertRegularFile(subjectPath, `Provenance subject is unsafe: ${subjectPath}`);
    const digest = sha256(subjectPath);
    const bundlePath = brainPetSigstoreBundlePath(bundlesRoot, digest);
    assert.equal(existsSync(bundlePath), false, `Provenance bundle already exists: ${bundlePath}`);
    signer({ subjectPath, bundlePath });
    assertRegularFile(bundlePath, `Cosign did not create a regular provenance bundle for ${basename(subjectPath)}.`);
    const bundleStat = lstatSync(bundlePath);
    assert.ok(bundleStat.size > 0 && bundleStat.size <= 2 * 1024 * 1024, `Provenance bundle is empty or oversized: ${bundlePath}`);
    assert.doesNotThrow(() => JSON.parse(readFileSync(bundlePath, "utf8")), `Provenance bundle is not valid JSON: ${bundlePath}`);
    verifier({
      subjectPath,
      bundlePath,
      repository: brainPetDistributionContract.identity.repository,
      workflowPath: workflow.path,
      workflowName: workflow.name,
      sourceCommit: environment.GITHUB_SHA,
      label: basename(subjectPath),
    });
    signed.push({ subjectPath, digest, bundlePath });
  }
  return signed;
}

export function verifyBrainPetSigstoreSubject(evidence) {
  assert.equal(evidence.repository, brainPetDistributionContract.identity.repository, "Sigstore provenance repository is invalid.");
  const workflow = trustedWorkflows.find((candidate) => candidate.path === evidence.workflowPath && candidate.name === evidence.workflowName);
  assert.ok(workflow, "Sigstore provenance workflow identity is invalid.");
  assert.match(evidence.sourceCommit ?? "", /^[a-f0-9]{40}$/i, "Sigstore provenance requires an exact source commit.");
  const subjectPath = resolve(evidence.subjectPath);
  assertRegularFile(subjectPath, `Sigstore subject is unsafe: ${subjectPath}`);
  const digest = sha256(subjectPath);
  const bundlePath = evidence.bundlePath ?? brainPetSigstoreBundlePath(evidence.bundlesRoot, digest);
  assertRegularFile(bundlePath, `Sigstore bundle is missing or unsafe for ${evidence.label ?? basename(subjectPath)}.`);
  const bundleStat = lstatSync(bundlePath);
  assert.ok(bundleStat.size > 0 && bundleStat.size <= 2 * 1024 * 1024, `Sigstore bundle is empty or oversized: ${bundlePath}`);
  const identity = `^https://github\\.com/${escapeRegex(evidence.repository)}/${escapeRegex(evidence.workflowPath)}@refs/(heads|tags)/.+$`;
  const commandRunner = evidence.commandRunner ?? spawnSync;
  const result = commandRunner("cosign", [
    "verify-blob",
    "--bundle", bundlePath,
    "--certificate-identity-regexp", identity,
    "--certificate-oidc-issuer", workflow.oidcIssuer,
    "--certificate-github-workflow-name", evidence.workflowName,
    "--certificate-github-workflow-repository", evidence.repository,
    "--certificate-github-workflow-sha", evidence.sourceCommit.toLowerCase(),
    "--certificate-github-workflow-trigger", workflow.trigger,
    subjectPath,
  ], { encoding: "utf8", timeout: 180_000, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr || `Sigstore provenance failed for ${evidence.label ?? basename(subjectPath)}.`);
  return { digest, bundlePath };
}

export function brainPetSigstoreBundlePath(bundlesRoot, digest) {
  assert.match(digest ?? "", /^[a-f0-9]{64}$/i, "Sigstore subject digest is invalid.");
  return join(resolve(bundlesRoot), `sha256-${digest.toLowerCase()}.sigstore.json`);
}

function runCosignSign({ subjectPath, bundlePath }) {
  const result = spawnSync("cosign", ["sign-blob", "--yes", "--oidc-provider", "github-actions", "--bundle", bundlePath, subjectPath], {
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || `Cosign signing failed for ${basename(subjectPath)}.`);
}

function assertTrustedSigningEnvironment(environment) {
  assert.equal(environment.GITHUB_ACTIONS, "true", "Sigstore signing is restricted to GitHub Actions.");
  assert.equal(environment.RUNNER_ENVIRONMENT, "github-hosted", "Sigstore signing requires a GitHub-hosted runner.");
  assert.equal(environment.GITHUB_REPOSITORY, brainPetDistributionContract.identity.repository, "Sigstore signing repository is invalid.");
  const workflow = trustedWorkflows.find((candidate) => candidate.name === environment.GITHUB_WORKFLOW);
  assert.ok(workflow, "Sigstore signing must run in an approved BrainPet release workflow.");
  assert.match(environment.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/i, "Sigstore signing requires an exact source commit.");
  return workflow;
}

function findFiles(directory, pattern) {
  assert.ok(existsSync(directory) && lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), `Evidence directory is missing or unsafe: ${directory}`);
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && pattern.test(entry.name)) files.push(path);
    }
  };
  visit(directory);
  return files;
}

function readJson(path) {
  assertRegularFile(path, `Evidence receipt is unsafe: ${path}`);
  const stat = lstatSync(path);
  assert.ok(stat.size <= 2 * 1024 * 1024, `Evidence receipt is oversized: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertRegularFile(path, message) {
  assert.ok(existsSync(path), message);
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), message);
}

function resolveSafeRelative(rootDirectory, value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 4096, "Evidence path is invalid.");
  const path = resolve(rootDirectory, value);
  const child = relative(resolve(rootDirectory), path);
  assert.ok(child && !child.startsWith("..") && !child.includes(`..${process.platform === "win32" ? "\\" : "/"}`), "Evidence artifact escaped its package root.");
  return path;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv) {
  const options = { subjects: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--packages") options.packagesRoot = argv[++index];
    else if (arg === "--lifecycle") options.lifecycleRoot = argv[++index];
    else if (arg === "--bridge") options.bridgeRoot = argv[++index];
    else if (arg === "--subject") options.subjects.push(argv[++index]);
    else if (arg === "--output") options.bundlesRoot = argv[++index];
    else throw new Error(`Unknown Sigstore provenance argument: ${arg}`);
  }
  assert.ok(options.bundlesRoot, "Sigstore provenance requires --output <bundle-dir>.");
  const hasEvidenceRoots = options.packagesRoot || options.lifecycleRoot || options.bridgeRoot;
  if (hasEvidenceRoots) assert.ok(options.packagesRoot && options.lifecycleRoot && options.bridgeRoot, "Release evidence signing requires --packages, --lifecycle and --bridge together.");
  assert.ok(hasEvidenceRoots || options.subjects.length > 0, "Sigstore provenance requires release evidence roots or at least one --subject.");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const signed = [];
    if (options.packagesRoot) signed.push(...signBrainPetReleaseEvidence(options));
    if (options.subjects.length > 0) signed.push(...signBrainPetSubjects(options.subjects, options.bundlesRoot));
    console.log(`BrainPet Sigstore provenance created (${signed.length} subjects).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
