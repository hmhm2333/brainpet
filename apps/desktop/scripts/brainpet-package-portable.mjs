#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const electronDist = dirname(require("electron"));
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js");

function findCachedTool(cacheName, marker) {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  const root = join(localAppData, "electron-builder", "Cache", cacheName);
  if (!existsSync(root)) return undefined;
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .find((candidate) => existsSync(join(candidate, marker)));
}

const nsisDir = findCachedTool("nsis-3.0.4.1", join("Bin", "makensis.exe"));
const nsisResourcesDir = findCachedTool("nsis-resources-3.4.1", join("plugins", "x86-unicode"));

const args = [
  electronBuilderCli,
  "--win",
  "portable",
  "--config.appId=dev.brainpet.app",
  "--config.productName=BrainPet",
  "--config.executableName=brainpet",
  "--config.artifactName=BrainPet-${version}-${os}-${arch}.${ext}",
  `--config.electronDist=${electronDist}`,
  // BrainPet portable is an unsigned private-test artifact. Skipping resource
  // editing avoids downloading winCodeSign and does not change runtime code.
  "--config.win.signAndEditExecutable=false",
];

const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...(nsisDir ? { ELECTRON_BUILDER_NSIS_DIR: nsisDir } : {}),
    ...(nsisResourcesDir ? { ELECTRON_BUILDER_NSIS_RESOURCES_DIR: nsisResourcesDir } : {}),
  },
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`electron-builder terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
