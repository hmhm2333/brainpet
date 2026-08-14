#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronDist = dirname(require("electron"));
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js");

const child = spawn(process.execPath, [
  electronBuilderCli,
  "--dir",
  "--win",
  "--config.appId=dev.brainpet.app",
  "--config.productName=BrainPet",
  "--config.executableName=brainpet",
  `--config.electronDist=${electronDist}`,
  "--config.win.signAndEditExecutable=false",
], {
  cwd: process.cwd(),
  env: process.env,
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
