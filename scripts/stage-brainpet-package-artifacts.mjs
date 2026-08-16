#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function stageBrainPetPackageArtifacts(options) {
  const sourceRoot = resolve(options.sourceRoot);
  const outputRoot = resolve(options.outputRoot);
  assert.equal(existsSync(outputRoot), false, `BrainPet staged package output already exists: ${outputRoot}`);
  const receiptName = `brainpet-package-receipt-${options.targetId}.json`;
  const receiptPath = join(sourceRoot, receiptName);
  const receipt = readJson(receiptPath);
  assert.equal(receipt.target, options.targetId, "BrainPet staged package target does not match its receipt.");
  assert.equal(receipt.releaseMode, "public-release", "Only public-release packages may enter the public artifact staging closure.");
  assert.equal(receipt.runtimeReleaseReady, true, "Only validated public runtime packages may enter the public artifact staging closure.");
  assert.ok(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0, "BrainPet package receipt has no distributable artifacts.");

  mkdirSync(outputRoot, { recursive: true });
  copyFileSync(receiptPath, join(outputRoot, receiptName));
  for (const artifact of receipt.artifacts) {
    assert.ok(isRecord(artifact) && typeof artifact.path === "string", "BrainPet staged artifact record is invalid.");
    assert.equal(artifact.path, basename(artifact.path), `BrainPet public artifact must be a top-level file: ${artifact.path}`);
    const source = resolveSafeRelative(sourceRoot, artifact.path);
    assertRegularFile(source, `BrainPet staged artifact is missing or unsafe: ${artifact.path}`);
    assert.equal(lstatSync(source).size, artifact.bytes, `BrainPet staged artifact size mismatch: ${artifact.path}`);
    assert.equal(sha256(source), artifact.sha256, `BrainPet staged artifact hash mismatch: ${artifact.path}`);
    copyFileSync(source, join(outputRoot, artifact.path));
  }
  return validateBrainPetPackageArtifactClosure(outputRoot, options.targetId);
}

export function validateBrainPetPackageArtifactClosure(packageRootArgument, expectedTargetId) {
  const packageRoot = resolve(packageRootArgument);
  assertDirectory(packageRoot, "BrainPet package artifact closure is missing or unsafe.");
  const entries = readdirSync(packageRoot, { withFileTypes: true });
  for (const entry of entries) assert.ok(entry.isFile() && !entry.isSymbolicLink(), `BrainPet package artifact closure contains an unexpected entry: ${entry.name}`);
  const receiptName = `brainpet-package-receipt-${expectedTargetId}.json`;
  const receiptMatches = entries.filter((entry) => entry.name === receiptName);
  assert.equal(receiptMatches.length, 1, `BrainPet package artifact closure must contain exactly one ${receiptName}.`);
  const receiptPath = join(packageRoot, receiptName);
  const receipt = readJson(receiptPath);
  assert.equal(receipt.target, expectedTargetId, "BrainPet package artifact closure target is invalid.");
  assert.ok(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0, "BrainPet package artifact closure has no artifacts.");
  const expectedNames = new Set([receiptName]);
  const artifactPaths = [];
  for (const artifact of receipt.artifacts) {
    assert.ok(isRecord(artifact) && typeof artifact.path === "string" && /^[a-f0-9]{64}$/i.test(artifact.sha256), "BrainPet package artifact closure record is invalid.");
    assert.equal(artifact.path, basename(artifact.path), `BrainPet package artifact closure path must be top-level: ${artifact.path}`);
    assert.equal(expectedNames.has(artifact.path), false, `BrainPet package artifact closure contains a duplicate path: ${artifact.path}`);
    expectedNames.add(artifact.path);
    const artifactPath = resolveSafeRelative(packageRoot, artifact.path);
    assertRegularFile(artifactPath, `BrainPet package artifact closure is missing ${artifact.path}.`);
    assert.equal(lstatSync(artifactPath).size, artifact.bytes, `BrainPet package artifact closure size mismatch: ${artifact.path}`);
    assert.equal(sha256(artifactPath), artifact.sha256.toLowerCase(), `BrainPet package artifact closure hash mismatch: ${artifact.path}`);
    artifactPaths.push(artifactPath);
  }
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [...expectedNames].sort(), "BrainPet package artifact closure contains an unreceipted file.");
  return { packageRoot, receiptPath, receipt, artifactPaths };
}

function readJson(path) {
  assertRegularFile(path, `BrainPet package receipt is missing or unsafe: ${path}`);
  const stat = lstatSync(path);
  assert.ok(stat.size <= 2 * 1024 * 1024, `BrainPet package receipt is oversized: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveSafeRelative(rootDirectory, value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 4096, "BrainPet package artifact path is invalid.");
  const path = resolve(rootDirectory, value);
  const child = relative(resolve(rootDirectory), path);
  assert.ok(child && !child.startsWith("..") && !child.includes(`..${process.platform === "win32" ? "\\" : "/"}`), "BrainPet package artifact escaped its closure root.");
  return path;
}

function assertRegularFile(path, message) {
  assert.ok(existsSync(path), message);
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), message);
}

function assertDirectory(path, message) {
  assert.ok(existsSync(path), message);
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), message);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--source") options.sourceRoot = argv[++index];
    else if (argv[index] === "--target") options.targetId = argv[++index];
    else if (argv[index] === "--output") options.outputRoot = argv[++index];
    else throw new Error(`Unknown BrainPet artifact staging argument: ${argv[index]}`);
  }
  assert.ok(options.sourceRoot && options.targetId && options.outputRoot, "Usage: stage-brainpet-package-artifacts.mjs --source <validated-package-dir> --target <target-id> --output <new-staging-dir>");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const staged = stageBrainPetPackageArtifacts(parseArgs(process.argv.slice(2)));
    console.log(`BrainPet public artifact closure staged (${staged.receipt.target}, ${staged.artifactPaths.length} installers).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
