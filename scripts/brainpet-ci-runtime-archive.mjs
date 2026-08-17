#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createBrainPetRuntimeTree } from "../apps/desktop/scripts/brainpet-runtime-tree.mjs";
import { brainPetReleaseTargets } from "./brainpet-release-contract.mjs";

const tarTimeoutMs = 15 * 60 * 1000;

export function createBrainPetCiRuntimeArchive(options, commandRunner = spawnSync) {
  const sourceRoot = resolve(options.sourceRoot);
  const archivePath = resolve(options.archivePath);
  assertDirectory(sourceRoot, "BrainPet CI runtime archive source is missing or unsafe.");
  assert.equal(existsSync(archivePath), false, `BrainPet CI runtime archive already exists: ${archivePath}`);
  createBrainPetRuntimeTree(sourceRoot);
  mkdirSync(dirname(archivePath), { recursive: true });
  runTar(commandRunner, ["-cf", archivePath, "-C", sourceRoot, "."], "Unable to create the BrainPet CI runtime archive.");
  assertRegularFile(archivePath, "BrainPet CI runtime archive was not created safely.");
  return { archivePath, sourceRoot };
}

export function extractBrainPetCiRuntimeArchive(options, commandRunner = spawnSync) {
  const archivePath = resolve(options.archivePath);
  const outputRoot = resolve(options.outputRoot);
  assertRegularFile(archivePath, "BrainPet CI runtime archive is missing or unsafe.");
  assert.equal(existsSync(outputRoot), false, `BrainPet CI runtime extraction output already exists: ${outputRoot}`);
  const listed = runTar(commandRunner, ["-tf", archivePath], "Unable to inspect the BrainPet CI runtime archive.");
  validateBrainPetCiRuntimeArchiveListing(listed.stdout);
  mkdirSync(outputRoot, { recursive: true });
  try {
    runTar(commandRunner, ["-xf", archivePath, "-C", outputRoot], "Unable to extract the BrainPet CI runtime archive.");
    const runtimeTree = createBrainPetRuntimeTree(outputRoot);
    return { archivePath, outputRoot, runtimeTree };
  } catch (error) {
    rmSync(outputRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

export function extractAllBrainPetCiRuntimeArchives(options, commandRunner = spawnSync) {
  const archivesRoot = resolve(options.archivesRoot);
  const outputRoot = resolve(options.outputRoot);
  assertDirectory(archivesRoot, "BrainPet CI runtime archive set is missing or unsafe.");
  assert.equal(existsSync(outputRoot), false, `BrainPet CI runtime archive-set output already exists: ${outputRoot}`);
  const entries = readdirSync(archivesRoot, { withFileTypes: true });
  const expectedNames = brainPetReleaseTargets.map((target) => `brainpet-runtime-current-${target.id}.tar`).sort();
  assert.deepEqual(entries.map((entry) => entry.name).sort(), expectedNames, "BrainPet CI runtime archive set is incomplete or contains an extra entry.");
  for (const entry of entries) assert.ok(entry.isFile() && !entry.isSymbolicLink(), `BrainPet CI runtime archive set contains an unsafe entry: ${entry.name}`);
  mkdirSync(outputRoot, { recursive: true });
  try {
    return expectedNames.map((name) => extractBrainPetCiRuntimeArchive({
      archivePath: join(archivesRoot, name),
      outputRoot: join(outputRoot, name.slice(0, -".tar".length)),
    }, commandRunner));
  } catch (error) {
    rmSync(outputRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

export function validateBrainPetCiRuntimeArchiveListing(output) {
  assert.equal(typeof output, "string", "BrainPet CI runtime archive listing is invalid.");
  const paths = new Set();
  for (const rawEntry of output.split(/\r?\n/)) {
    if (!rawEntry) continue;
    assert.equal(/[\0-\x1f\x7f]/.test(rawEntry), false, "BrainPet CI runtime archive contains a control character in a path.");
    assert.equal(rawEntry.includes("\\") || rawEntry.includes(":"), false, `BrainPet CI runtime archive path is not portable: ${rawEntry}`);
    let entry = rawEntry;
    while (entry.startsWith("./")) entry = entry.slice(2);
    while (entry.endsWith("/")) entry = entry.slice(0, -1);
    if (!entry) continue;
    assert.equal(isAbsolute(entry), false, `BrainPet CI runtime archive path is absolute: ${rawEntry}`);
    const segments = entry.split("/");
    assert.ok(segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), `BrainPet CI runtime archive path is unsafe: ${rawEntry}`);
    assert.equal(paths.has(entry), false, `BrainPet CI runtime archive contains a duplicate path: ${entry}`);
    paths.add(entry);
  }
  assert.ok(paths.size > 0, "BrainPet CI runtime archive is empty.");
  return paths;
}

function runTar(commandRunner, args, message) {
  const result = commandRunner("tar", args, { encoding: "utf8", timeout: tarTimeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message || message);
  assert.equal(result.status, 0, result.stderr || message);
  return result;
}

function assertDirectory(path, message) {
  assert.ok(existsSync(path), message);
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), message);
}

function assertRegularFile(path, message) {
  assert.ok(existsSync(path), message);
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), message);
}

function parseArgs(argv) {
  const [command, ...values] = argv;
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (name === "--source") options.sourceRoot = values[++index];
    else if (name === "--archive") options.archivePath = values[++index];
    else if (name === "--archives") options.archivesRoot = values[++index];
    else if (name === "--output") options.outputRoot = values[++index];
    else throw new Error(`Unknown BrainPet CI runtime archive argument: ${name}`);
  }
  return { command, options };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command === "create" && options.sourceRoot && options.archivePath) createBrainPetCiRuntimeArchive(options);
    else if (command === "extract" && options.archivePath && options.outputRoot) extractBrainPetCiRuntimeArchive(options);
    else if (command === "extract-all" && options.archivesRoot && options.outputRoot) extractAllBrainPetCiRuntimeArchives(options);
    else throw new Error("Usage: brainpet-ci-runtime-archive.mjs <create|extract|extract-all> --source <dir> --archive <tar> --archives <dir> --output <dir>");
    console.log(`BrainPet CI runtime archive ${command} passed.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
