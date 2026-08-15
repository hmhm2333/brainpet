#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleBridgeRelease } from "../integrations/codex/scripts/assemble-bridge-release.mjs";
import { validateBridgeRelease } from "../integrations/codex/scripts/validate-bridge-release.mjs";
import { brainPetReleaseTargets } from "./brainpet-release-contract.mjs";
import { assertBrainPetBinary } from "./brainpet-binary-format.mjs";
import { validatePublicReleaseEnvironment } from "../apps/desktop/scripts/brainpet-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = join(root, "output", "brainpet-m5-release-test", String(process.pid));
const artifactsRoot = join(testRoot, "artifacts");
const pluginRoot = join(testRoot, "brainpet-codex-bridge");

try {
  for (const [index, target] of brainPetReleaseTargets.entries()) {
    const targetRoot = join(artifactsRoot, target.id);
    mkdirSync(targetRoot, { recursive: true });
    const file = join(targetRoot, target.helperName);
    writeFileSync(file, createExecutableFixture(target, 20 * 1024 + index));
    if (target.platform !== "windows") chmodSync(file, 0o755);
  }
  const receipt = assembleBridgeRelease({ artifactsRoot, outputRoot: pluginRoot });
  assert.equal(receipt.files.length, 6);
  assert.equal(new Set(receipt.files.map((file) => file.sha256)).size, 6);
  assert.deepEqual(validateBridgeRelease(pluginRoot), { targetCount: 6, receipt: true });
  assert.throws(() => assertBrainPetBinary(Buffer.alloc(20 * 1024, 7), brainPetReleaseTargets[0]), /Unsupported executable/);
  assert.throws(() => validatePublicReleaseEnvironment(brainPetReleaseTargets.find((target) => target.id === "windows-x64"), {}), /signing credentials/);
  assert.throws(() => validatePublicReleaseEnvironment(brainPetReleaseTargets.find((target) => target.id === "macos-arm64"), {}), /Developer ID/);
  assert.throws(() => validatePublicReleaseEnvironment(brainPetReleaseTargets.find((target) => target.id === "linux-x64"), {}), /provenance/i);
  console.log("BrainPet release assembly test passed.");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

function createExecutableFixture(target, size) {
  const bytes = Buffer.alloc(size);
  if (target.binaryFormat === "pe") {
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(0x80, 0x3c);
    bytes.write("PE\0\0", 0x80, "binary");
    bytes.writeUInt16LE(target.machine, 0x84);
    bytes.writeUInt16LE(1, 0x86);
    bytes.writeUInt16LE(0xf0, 0x94);
    bytes.writeUInt16LE(0x20b, 0x98);
  } else if (target.binaryFormat === "elf") {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    bytes.writeUInt16LE(3, 16);
    bytes.writeUInt16LE(target.machine, 18);
    bytes.writeUInt32LE(1, 20);
    bytes.writeBigUInt64LE(64n, 32);
    bytes.writeUInt16LE(64, 52);
    bytes.writeUInt16LE(56, 54);
    bytes.writeUInt16LE(1, 56);
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target.machine, 4);
    bytes.writeUInt32LE(2, 12);
    bytes.writeUInt32LE(1, 16);
    bytes.writeUInt32LE(72, 20);
    bytes.writeUInt32LE(0x19, 32);
    bytes.writeUInt32LE(72, 36);
  }
  return bytes;
}
