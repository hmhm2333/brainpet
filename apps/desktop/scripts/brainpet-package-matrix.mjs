#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetReleaseTargets } from "../../../scripts/brainpet-release-contract.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const target of brainPetReleaseTargets) {
  const result = spawnSync(process.execPath, ["scripts/brainpet-package.mjs", "--platform", target.platform, "--arch", target.arch, "--target", "installer", "--dry-run"], { cwd: appDir, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `Dry-run failed for ${target.id}`);
  const receipt = JSON.parse(result.stdout);
  if (receipt.releaseTarget.id !== target.id || receipt.signedPublicArtifact !== true) throw new Error(`Invalid package receipt for ${target.id}`);
  console.log(`validated ${target.id}`);
}
