#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetDistributionContract, brainPetReleaseTargets, brainPetReleaseTargetIds } from "../../../scripts/brainpet-release-contract.mjs";
import { assertBrainPetBinary } from "../../../scripts/brainpet-binary-format.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultPluginRoot = resolve(scriptDir, "..", "plugins", "brainpet-codex-bridge");

export function validateBridgeRelease(pluginRoot = defaultPluginRoot) {
  const contract = JSON.parse(readFileSync(join(pluginRoot, "brainpet.bridge.json"), "utf8"));
  assert.equal(contract.schemaVersion, 1);
  assert.deepEqual(contract.releaseTargets, brainPetReleaseTargetIds);
  assert.equal(contract.bridgeVersion, brainPetDistributionContract.bridge.version);
  assert.equal(contract.minimumRuntimeIpcVersion, brainPetDistributionContract.bridge.minimumRuntimeIpcVersion);
  assert.equal(contract.hookDeadlineMs, brainPetDistributionContract.bridge.hookDeadlineMs);
  assert.equal(contract.connectAttemptMs, brainPetDistributionContract.bridge.connectAttemptMs);
  assert.deepEqual(contract.transportPriority, ["native-hook", "node-development-fallback"]);

  const receiptPath = join(pluginRoot, "brainpet-release.json");
  const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null;
  if (receipt) assert.equal(receipt.bridgeVersion, contract.bridgeVersion);

  for (const target of brainPetReleaseTargets) {
    const path = join(pluginRoot, "bin", target.id, target.helperName);
    assert.ok(existsSync(path), `Bridge helper is missing: ${target.id}/${target.helperName}`);
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Bridge helper must be a regular file: ${target.id}/${target.helperName}`);
    assert.ok(stat.size >= 16 * 1024 && stat.size <= 20 * 1024 * 1024, `Bridge helper size is implausible: ${target.id}/${target.helperName}`);
    assertBrainPetBinary(readFileSync(path), target, `Bridge helper ${target.id}`);
    if (process.platform !== "win32" && target.platform !== "windows") assert.ok((stat.mode & 0o111) !== 0, `Unix bridge helper must retain its executable bit: ${target.id}/${target.helperName}`);
    if (receipt) {
      const record = receipt.files.find((candidate) => candidate.target === target.id);
      assert.ok(record, `Release receipt is missing ${target.id}.`);
      assert.equal(record.sha256, createHash("sha256").update(readFileSync(path)).digest("hex"), `Release receipt hash mismatch for ${target.id}.`);
    }
  }

  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.version, contract.bridgeVersion, "Plugin and Bridge versions must match.");
  assert.match(manifest.homepage, /^https:\/\/github\.com\/hmhm2333\/brainpet/);
  assert.match(manifest.interface?.privacyPolicyURL, /PRIVACY\.md$/);
  assert.equal(typeof manifest.interface?.logo, "string", "Plugin manifest must declare a pixel logo.");
  assert.ok(existsSync(join(pluginRoot, manifest.interface.logo)), "Plugin pixel logo is missing.");

  const hooks = JSON.parse(readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const definitions = Object.values(hooks.hooks).flatMap((entries) => entries).flatMap((entry) => entry.hooks);
  assert.ok(definitions.length > 0, "Codex plugin must declare lifecycle hooks.");
  assert.ok(definitions.every((hook) => hook.command.includes("bridge.sh")), "Every Unix hook must use the native-helper launcher.");
  assert.ok(definitions.every((hook) => hook.commandWindows.includes("bridge.cmd")), "Every Windows hook must use the native-helper launcher.");
  assert.ok(definitions.every((hook) => !hook.command.startsWith("node ") && !hook.commandWindows.startsWith("node ")), "Published hook definitions must not directly require Node.");
  assert.ok(definitions.every((hook) => hook.timeout * 1_000 >= contract.hookDeadlineMs || hook.timeout === 1), "Lifecycle hook timeouts must contain the Bridge deadline; SessionEnd may use the bounded one-second no-wake path.");
  return { targetCount: brainPetReleaseTargets.length, receipt: Boolean(receipt) };
}

function parsePluginRoot(argv) {
  if (argv.length === 0) return defaultPluginRoot;
  if (argv.length === 2 && argv[0] === "--plugin-root") return resolve(argv[1]);
  throw new Error("Usage: validate-bridge-release.mjs [--plugin-root <directory>]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validateBridgeRelease(parsePluginRoot(process.argv.slice(2)));
    console.error(`BrainPet bridge release validation passed (${result.targetCount} targets, receipt=${result.receipt}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
