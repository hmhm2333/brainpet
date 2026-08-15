#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { assertBrainPetBinary } from "./brainpet-binary-format.mjs";
import { brainPetDistributionContract, brainPetReleaseTargets } from "./brainpet-release-contract.mjs";

const [targetId, executableArgument] = process.argv.slice(2);
const target = brainPetReleaseTargets.find((candidate) => candidate.id === targetId);
assert.ok(target && executableArgument, "Usage: validate-native-helper.mjs <target-id> <executable>");
const executable = resolve(executableArgument);
assertBrainPetBinary(readFileSync(executable), target, `Native helper ${target.id}`);
const result = spawnSync(executable, ["--self-test"], { encoding: "utf8", timeout: 2_000, windowsHide: true });
assert.equal(result.status, 0, result.error?.message || result.stderr || "Native helper self-test failed.");
assert.equal(result.stdout.trim(), `brainpet-hook ${brainPetDistributionContract.bridge.version} ok`);
console.log(`BrainPet native helper self-test passed (${target.id}).`);
