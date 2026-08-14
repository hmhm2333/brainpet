#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleBridgeRelease } from "../integrations/codex/scripts/assemble-bridge-release.mjs";
import { validateBridgeRelease } from "../integrations/codex/scripts/validate-bridge-release.mjs";
import { brainPetReleaseTargets } from "./brainpet-release-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = join(root, "output", "brainpet-m5-release-test", String(process.pid));
const artifactsRoot = join(testRoot, "artifacts");
const pluginRoot = join(testRoot, "brainpet-codex-bridge");

try {
  for (const [index, target] of brainPetReleaseTargets.entries()) {
    const targetRoot = join(artifactsRoot, target.id);
    mkdirSync(targetRoot, { recursive: true });
    const file = join(targetRoot, target.helperName);
    writeFileSync(file, Buffer.alloc(20 * 1024 + index, index + 1));
    if (target.platform !== "windows") chmodSync(file, 0o755);
  }
  const receipt = assembleBridgeRelease({ artifactsRoot, outputRoot: pluginRoot });
  assert.equal(receipt.files.length, 6);
  assert.equal(new Set(receipt.files.map((file) => file.sha256)).size, 6);
  assert.deepEqual(validateBridgeRelease(pluginRoot), { targetCount: 6, receipt: true });
  console.log("BrainPet release assembly test passed.");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
