#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const [receiptArgument, outputArgument] = process.argv.slice(2);
if (!receiptArgument || !outputArgument) throw new Error("Usage: collect-brainpet-provenance.mjs <package-receipt.json> <bundle.jsonl>");
assert.equal(process.env.GITHUB_ACTIONS, "true", "GitHub provenance collection is restricted to Actions.");
const receiptPath = resolve(receiptArgument);
const packageRoot = dirname(receiptPath);
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
assert.ok(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0, "Package receipt has no artifacts to attest.");
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ? resolve(process.env.RUNNER_TEMP) : tmpdir(), "brainpet-attestations-"));
try {
  for (const artifact of receipt.artifacts) {
    const path = resolve(packageRoot, artifact.path);
    assert.ok(path.startsWith(`${packageRoot}${process.platform === "win32" ? "\\" : "/"}`), "Attestation artifact escaped package root.");
    let result;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      result = spawnSync("gh", ["attestation", "download", path, "--repo", process.env.GITHUB_REPOSITORY], { cwd: scratch, encoding: "utf8", windowsHide: true });
      if (result.status === 0) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    }
    assert.equal(result.status, 0, result.error?.message || result.stderr || `Failed to download attestation for ${artifact.path}.`);
  }
  const bundleFiles = readdirSync(scratch).filter((name) => /^sha256[-:].+\.jsonl$/i.test(name)).sort();
  assert.equal(bundleFiles.length, receipt.artifacts.length, "Every package artifact must have one downloaded GitHub attestation bundle.");
  const bytes = bundleFiles.map((name) => readFileSync(join(scratch, name), "utf8").trim()).filter(Boolean).join("\n");
  assert.ok(bytes.length > 0, "Downloaded provenance bundle is empty.");
  writeFileSync(resolve(outputArgument), `${bytes}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(`Collected ${bundleFiles.length} verified-subject attestation bundles.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
