#!/usr/bin/env node
/**
 * Desktop test runner
 * Runs preload checks, builds and runs behavior tests, contract tests, then remaining dist checks.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import electronPath from "electron";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const preloadChecks = ["control-center-preload.cjs", "pet-preload.cjs", "brainpet-preload.cjs", "brainpet-setup-preload.cjs", "plugin-sdk-preload.cjs", "panel-preload.cjs"];
const distChecks = [
  "dist/check-opencode-desktop-setup.js",
  "dist/check-cursor-desktop.js",
  "dist/check-packaging-contract.js",
];

function commandForPlatform(command, args) {
  if (process.platform === "win32" && command === "pnpm") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd", ...args] };
  }
  return { command, args };
}

function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const platformCommand = commandForPlatform(command, args);
    const child = spawn(platformCommand.command, platformCommand.args, {
      stdio: "inherit",
      cwd: rootDir,
      env: { ...process.env, OPENPETS_DESKTOP_ROOT: rootDir },
      ...options,
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(" ")}`));
      } else {
        resolve();
      }
    });
    child.on("error", reject);
  });
}

async function main() {
  // 1. Preload syntax checks
  console.log("\n[1/5] Checking preload syntax...");
  for (const preload of preloadChecks) await run("node", ["--check", preload]);

  // 2. Build tests
  console.log("\n[2/5] Building tests...");
  await rm(join(rootDir, ".test-dist"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await run("pnpm", ["test:build"]);

  const behaviorTests = (await readdir(join(rootDir, ".test-dist", "tests")))
    .filter((name) => name.endsWith(".test.js"))
    .filter((name) => name !== "app-state-migration.test.js")
    .sort()
    .map((name) => `.test-dist/tests/${name}`);
  const contractTests = (await readdir(join(rootDir, ".test-dist", "contracts")))
    .filter((name) => name.endsWith(".contract.js"))
    .sort()
    .map((name) => `.test-dist/contracts/${name}`);

  // 3. Run behavior tests
  console.log("\n[3/5] Running behavior tests...");
  for (const test of behaviorTests) await run("node", [test]);
  await run(electronPath, [".test-dist/tests/app-state-migration.test.js"], {
    env: { ...process.env, OPENPETS_DESKTOP_ROOT: rootDir, ELECTRON_RUN_AS_NODE: undefined },
  });

  // 4. Run contract tests
  console.log("\n[4/5] Running contract tests...");
  for (const test of contractTests) await run("node", [test]);

  // 5. Run remaining dist checks
  console.log("\n[5/5] Running dist checks...");
  await run("pnpm", ["build:main"]);
  for (const check of distChecks) {
    await run("node", [check]);
  }

  console.log("\nâœ“ All tests passed!");
}

main().catch((err) => {
  console.error("\nâœ— Test suite failed:", err.message);
  process.exit(1);
});
