#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(integrationRoot, "plugins", "brainpet-codex-bridge");
const targets = [
  ["windows-x64", "brainpet-hook.exe", false],
  ["windows-arm64", "brainpet-hook.exe", false],
  ["macos-x64", "brainpet-hook", true],
  ["macos-arm64", "brainpet-hook", true],
];

for (const [platform, filename, mustBeExecutable] of targets) {
  const path = join(pluginRoot, "bin", platform, filename);
  assert.ok(existsSync(path), `Bridge helper is missing: ${platform}/${filename}`);
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Bridge helper must be a regular file: ${platform}/${filename}`);
  assert.ok(stat.size >= 16 * 1024 && stat.size <= 20 * 1024 * 1024, `Bridge helper size is implausible: ${platform}/${filename}`);
  if (mustBeExecutable) assert.ok((stat.mode & 0o111) !== 0, `macOS bridge helper must retain its executable bit: ${platform}/${filename}`);
}

const hooks = JSON.parse(readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
const definitions = Object.values(hooks.hooks).flatMap((entries) => entries).flatMap((entry) => entry.hooks);
assert.ok(definitions.length > 0, "Codex plugin must declare lifecycle hooks.");
assert.ok(definitions.every((hook) => hook.command.includes("bridge.sh")), "Every macOS hook must use the native-helper launcher.");
assert.ok(definitions.every((hook) => hook.commandWindows.includes("bridge.cmd")), "Every Windows hook must use the native-helper launcher.");
assert.ok(definitions.every((hook) => !hook.command.startsWith("node ") && !hook.commandWindows.startsWith("node ")), "Published hook definitions must not directly require Node.");

console.error("BrainPet bridge release validation passed.");
