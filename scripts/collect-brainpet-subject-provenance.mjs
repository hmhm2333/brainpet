#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract } from "./brainpet-release-contract.mjs";

export function collectBrainPetSubjectProvenance(subjectArgument, outputArgument) {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "GitHub provenance collection is restricted to Actions.");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "GitHub provenance collection requires a GitHub-hosted runner.");
  assert.equal(process.env.GITHUB_REPOSITORY, brainPetDistributionContract.identity.repository, "GitHub provenance repository is invalid.");
  const subjectPath = resolve(subjectArgument);
  const outputPath = resolve(outputArgument);
  const subjectStat = lstatSync(subjectPath);
  assert.ok(subjectStat.isFile() && !subjectStat.isSymbolicLink() && subjectStat.size <= 2 * 1024 * 1024, "Provenance subject must be a bounded regular receipt file.");
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ? resolve(process.env.RUNNER_TEMP) : tmpdir(), "brainpet-subject-attestation-"));
  try {
    let result;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      result = spawnSync("gh", ["attestation", "download", subjectPath, "--repo", process.env.GITHUB_REPOSITORY], { cwd: scratch, encoding: "utf8", windowsHide: true });
      if (result.status === 0) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    }
    assert.equal(result.status, 0, result.error?.message || result.stderr || `Failed to download attestation for ${basename(subjectPath)}.`);
    const bundles = readdirSync(scratch).filter((name) => /^sha256[-:].+\.jsonl$/i.test(name));
    assert.equal(bundles.length, 1, `Expected one provenance bundle for ${basename(subjectPath)}.`);
    const bytes = readFileSync(join(scratch, bundles[0]), "utf8").trim();
    assert.ok(bytes.length > 0, "Downloaded provenance bundle is empty.");
    writeFileSync(outputPath, `${bytes}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return outputPath;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [subject, output] = process.argv.slice(2);
    assert.ok(subject && output, "Usage: collect-brainpet-subject-provenance.mjs <subject> <bundle.jsonl>");
    console.log(`Collected BrainPet subject provenance: ${collectBrainPetSubjectProvenance(subject, output)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
