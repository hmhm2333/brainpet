#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brainPetReleaseTargets } from "../../../scripts/brainpet-release-contract.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const target of brainPetReleaseTargets) {
  for (const mode of ["private-test", "public-release"]) {
    const result = spawnSync(process.execPath, ["scripts/brainpet-package.mjs", "--platform", target.platform, "--arch", target.arch, "--target", "installer", "--mode", mode, "--dry-run"], { cwd: appDir, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || `Dry-run failed for ${target.id}/${mode}`);
    const receipt = JSON.parse(result.stdout);
    if (receipt.releaseTarget.id !== target.id || receipt.releaseMode !== mode || receipt.publicArtifact !== (mode === "public-release")) throw new Error(`Invalid package receipt for ${target.id}/${mode}`);
  }
  console.log(`validated ${target.id}`);
}
