#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract, brainPetReleaseTargets } from "./brainpet-release-contract.mjs";
import { brainPetPublicReleaseWorkflow, verifyBrainPetSigstoreSubject } from "./brainpet-sigstore-provenance.mjs";

export function downloadBrainPetPublicCandidate(options) {
  assert.match(options.runId ?? "", /^\d{1,20}$/, "Public candidate run id is invalid.");
  assert.match(options.sourceCommit ?? "", /^[a-f0-9]{40}$/i, "Public candidate download requires an exact source commit.");
  assert.equal(options.repository, brainPetDistributionContract.identity.repository, "Public candidate repository is invalid.");
  const outputRoot = resolve(options.outputRoot);
  assert.equal(existsSync(outputRoot), false, `Public candidate output already exists: ${outputRoot}`);

  const run = JSON.parse(runGh(["api", `repos/${options.repository}/actions/runs/${options.runId}`]).stdout);
  assert.equal(String(run.id), options.runId);
  assert.equal(String(run.path).split("@")[0], ".github/workflows/brainpet-public-release-gate.yml", "Candidate evidence came from the wrong workflow file.");
  assert.equal(run.head_sha.toLowerCase(), options.sourceCommit.toLowerCase(), "Candidate workflow ran against a different commit.");
  assert.equal(run.conclusion, "success", "Public candidate workflow did not succeed.");
  assert.equal(run.event, "workflow_dispatch", "Public candidate must be manually dispatched.");
  assert.equal(run.repository?.full_name, options.repository);

  const packagesRoot = join(outputRoot, "packages");
  const lifecycleRoot = join(outputRoot, "lifecycle");
  const bridgeRoot = join(outputRoot, "bridge");
  const receiptRoot = join(outputRoot, "candidate-receipt");
  const provenanceRoot = join(outputRoot, "provenance");
  runGh(["run", "download", options.runId, "--repo", options.repository, "--pattern", "brainpet-public-runtime-current-*", "--dir", packagesRoot]);
  runGh(["run", "download", options.runId, "--repo", options.repository, "--pattern", "brainpet-public-lifecycle-*", "--dir", lifecycleRoot]);
  runGh(["run", "download", options.runId, "--repo", options.repository, "--name", "brainpet-public-bridge", "--dir", bridgeRoot]);
  runGh(["run", "download", options.runId, "--repo", options.repository, "--name", "brainpet-public-candidate-receipt", "--dir", receiptRoot]);
  runGh(["run", "download", options.runId, "--repo", options.repository, "--name", "brainpet-public-provenance", "--dir", provenanceRoot]);

  assert.equal(findFiles(packagesRoot, /^brainpet-package-receipt-[a-z0-9-]+\.json$/).length, brainPetReleaseTargets.length, "Public candidate package evidence is incomplete.");
  assert.equal(findFiles(lifecycleRoot, /^brainpet-install-lifecycle-receipt-[a-z0-9-]+-[a-z0-9-]+\.json$/).length, 4, "Public candidate lifecycle evidence is incomplete.");
  assert.equal(findFiles(bridgeRoot, /^brainpet-release\.json$/).length, 1, "Public candidate Bridge evidence is incomplete.");
  const candidatePaths = findFiles(receiptRoot, /^brainpet-release-receipt\.json$/);
  assert.equal(candidatePaths.length, 1, "Public candidate aggregate receipt is missing.");
  const candidate = readJson(candidatePaths[0]);
  assert.equal(candidate.schemaVersion, 2);
  assert.equal(candidate.product, "brainpet");
  assert.equal(candidate.releaseMode, "public-release");
  assert.equal(candidate.sourceCommit.toLowerCase(), options.sourceCommit.toLowerCase());
  assert.equal(String(candidate.sourceRunId), options.runId, "Public candidate receipt does not bind the selected workflow run.");
  assert.equal(candidate.rc6GatePassed, true);
  assert.equal(candidate.publicReleaseReady, false);
  assert.deepEqual(candidate.releasePolicy, brainPetDistributionContract.releasePolicy);
  assert.equal(candidate.operatingSystemPublisherTrust, false);
  assert.equal(candidate.manualUserConsentRequired, true);
  assert.deepEqual(candidate.missingEvidence.sort(), ["macos-arm64:physical-acceptance", "windows-x64:physical-acceptance"]);
  const provenanceVerifier = options.provenanceVerifier ?? verifyBrainPetSigstoreSubject;
  provenanceVerifier({
    subjectPath: candidatePaths[0],
    bundlesRoot: provenanceRoot,
    repository: options.repository,
    workflowPath: brainPetPublicReleaseWorkflow.path,
    workflowName: brainPetPublicReleaseWorkflow.name,
    sourceCommit: options.sourceCommit,
    label: "BrainPet public candidate receipt",
  });
  return { runId: options.runId, packagesRoot, lifecycleRoot, bridgeRoot, provenanceRoot, receiptPath: candidatePaths[0] };
}

function readJson(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, `Candidate receipt is unsafe or oversized: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function runGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 120_000, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr || `gh ${args.join(" ")} failed.`);
  return result;
}

function findFiles(directory, pattern) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return findFiles(path, pattern);
    return entry.isFile() && pattern.test(entry.name) ? [path] : [];
  });
}

function parseArgs(argv) {
  const options = { repository: process.env.GITHUB_REPOSITORY, sourceCommit: process.env.GITHUB_SHA };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run-id") options.runId = argv[++index];
    else if (argv[index] === "--output") options.outputRoot = argv[++index];
    else throw new Error(`Unknown public candidate download argument: ${argv[index]}`);
  }
  assert.ok(options.runId && options.outputRoot, "Usage: download-brainpet-public-candidate.mjs --run-id <id> --output <dir>");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Public candidate download is restricted to GitHub Actions.");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "Public candidate download requires a GitHub-hosted runner.");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const candidate = downloadBrainPetPublicCandidate(parseArgs(process.argv.slice(2)));
    console.log(`BrainPet public candidate verified (run ${candidate.runId}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
