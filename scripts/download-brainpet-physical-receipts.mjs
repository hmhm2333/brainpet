#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "./brainpet-release-contract.mjs";
import { validateBrainPetPhysicalReceiptSet } from "./brainpet-physical-receipt-contract.mjs";

export function downloadBrainPetPhysicalReceipts(options) {
  assert.match(options.runId ?? "", /^\d{1,20}$/, "Physical receipt run id is invalid.");
  assert.match(options.sourceCommit ?? "", /^[a-f0-9]{40}$/i, "Physical receipt download requires an exact source commit.");
  assert.equal(options.repository, brainPetDistributionContract.identity.repository, "Physical receipt download repository is invalid.");
  const outputRoot = resolve(options.outputRoot);
  assert.equal(existsSync(outputRoot), false, `Physical receipt download output already exists: ${outputRoot}`);

  const run = JSON.parse(runGh(["api", `repos/${options.repository}/actions/runs/${options.runId}`]).stdout);
  assert.equal(String(run.id), options.runId);
  assert.equal(String(run.path).split("@")[0], ".github/workflows/brainpet-physical-receipt-intake.yml", "Physical receipt artifact came from the wrong workflow file.");
  assert.equal(run.head_sha.toLowerCase(), options.sourceCommit.toLowerCase(), "Physical receipt workflow ran against a different commit.");
  assert.equal(run.conclusion, "success", "Physical receipt intake workflow did not succeed.");
  assert.equal(run.event, "workflow_dispatch", "Physical receipt intake must be manually dispatched.");
  assert.equal(run.repository?.full_name, options.repository);
  runGh(["run", "download", options.runId, "--repo", options.repository, "--name", "brainpet-physical-receipts", "--dir", outputRoot]);
  const receipts = findFiles(outputRoot, "brainpet-physical-receipt.json").map((path) => readJson(path));
  validateBrainPetPhysicalReceiptSet(receipts, { expectedSourceCommit: options.sourceCommit });
  return { runId: options.runId, sourceCommit: options.sourceCommit, targets: receipts.map((receipt) => receipt.target).sort() };
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

function findFiles(directory, name) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return findFiles(path, name);
    return entry.isFile() && entry.name === name ? [path] : [];
  });
}

function parseArgs(argv) {
  const options = { repository: process.env.GITHUB_REPOSITORY, sourceCommit: process.env.GITHUB_SHA };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run-id") options.runId = argv[++index];
    else if (argv[index] === "--output") options.outputRoot = argv[++index];
    else throw new Error(`Unknown physical receipt download argument: ${argv[index]}`);
  }
  assert.ok(options.runId && options.outputRoot, "Usage: download-brainpet-physical-receipts.mjs --run-id <id> --output <dir>");
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
