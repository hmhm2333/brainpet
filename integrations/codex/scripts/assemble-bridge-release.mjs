#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract, brainPetReleaseTargets } from "../../../scripts/brainpet-release-contract.mjs";
import { assertBrainPetBinary } from "../../../scripts/brainpet-binary-format.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourcePluginRoot = resolve(scriptDir, "..", "plugins", "brainpet-codex-bridge");

function assertSafeOutput(path) {
  const resolved = resolve(path);
  const repoRoot = resolve(scriptDir, "..", "..", "..");
  const allowedRoot = join(repoRoot, "output");
  const relativePath = relative(allowedRoot, resolved);
  if (!relativePath || relativePath.startsWith("..")) throw new Error("Bridge output must be a dedicated directory under the repository output folder.");
  return resolved;
}

export function assembleBridgeRelease({ artifactsRoot, outputRoot }) {
  const artifacts = resolve(artifactsRoot);
  const output = assertSafeOutput(outputRoot);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  cpSync(sourcePluginRoot, output, { recursive: true, filter: (source) => !relative(sourcePluginRoot, source).split(/[\\/]/).includes("bin") });

  const files = [];
  for (const target of brainPetReleaseTargets) {
    const source = join(artifacts, target.id, target.helperName);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid helper artifact: ${target.id}/${target.helperName}`);
    const destination = join(output, "bin", target.id, target.helperName);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
    if (target.platform !== "windows") chmodSync(destination, 0o755);
    const bytes = readFileSync(destination);
    assertBrainPetBinary(bytes, target, `Bridge helper ${target.id}`);
    files.push({ target: target.id, path: `bin/${target.id}/${target.helperName}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const receipt = { schemaVersion: 1, bridgeVersion: brainPetDistributionContract.bridge.version, createdAt: new Date().toISOString(), files };
  writeFileSync(join(output, "brainpet-release.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifacts") options.artifactsRoot = argv[++index];
    else if (arg === "--output") options.outputRoot = argv[++index];
    else throw new Error(`Unknown bridge assembly argument: ${arg}`);
  }
  if (!options.artifactsRoot || !options.outputRoot) throw new Error("Usage: assemble-bridge-release.mjs --artifacts <directory> --output <directory>");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = assembleBridgeRelease(parseArgs(process.argv.slice(2)));
    console.log(`Assembled BrainPet Bridge ${receipt.bridgeVersion} with ${receipt.files.length} native helpers.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
