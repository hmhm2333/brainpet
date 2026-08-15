#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const appRoot = resolve(import.meta.dirname, "..");
const electron = createRequire(import.meta.url)("electron");
const userDataPath = await mkdtemp(join(tmpdir(), "brainpet-single-instance-"));
const discoveryPath = join(userDataPath, "ipc.json");
const firstPort = await reservePort();
const secondPort = await reservePort();
const sharedEnvironment = {
  ...process.env,
  OPENPETS_DISTRIBUTION_PROFILE: "brainpet",
  BRAINPET_ENABLED: "0",
  OPENPETS_DISCOVERY_FILE: discoveryPath,
  OPENPETS_DISABLE_PLUGIN_CATALOG: "1",
  OPENPETS_LOG_CONSOLE: "1",
};
const first = launch(firstPort);
const firstOutput = collect(first);

try {
  await waitForDevTools(firstPort, 20_000);
  const second = launch(secondPort);
  const secondOutput = collect(second);
  const secondExit = await waitForExit(second, 10_000);
  assert.equal(secondExit.timedOut, false, "A duplicate BrainPet runtime did not exit within the single-instance budget.");
  assert.equal(secondExit.code, 0, `The duplicate BrainPet runtime failed instead of exiting cleanly.\n${secondOutput.join("")}`);
  await waitForOutput(firstOutput, /Second BrainPet launch requested; keeping existing instance\./, 5_000);
  await waitForDevTools(firstPort, 2_000);
  assert.equal(await endpointAvailable(secondPort), false, "A duplicate BrainPet runtime opened a second browser process.");
  process.stdout.write(`${JSON.stringify({ singleInstance: true, duplicateExitCode: secondExit.code, duplicateOpenedRuntime: false })}\n`);
} catch (error) {
  process.stderr.write(`${firstOutput.join("")}\n`);
  throw error;
} finally {
  first.kill();
  await waitForExit(first, 5_000);
  if (process.platform === "win32") await stopProcessesForUserDataDir(userDataPath);
  await rm(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function launch(debugPort) {
  return spawn(electron, [".", `--user-data-dir=${userDataPath}`, `--remote-debugging-port=${debugPort}`], {
    cwd: appRoot,
    env: sharedEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function collect(child) {
  const chunks = [];
  child.stdout?.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr?.on("data", (chunk) => chunks.push(String(chunk)));
  return chunks;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await endpointAvailable(port)) return;
    await delay(100);
  }
  throw new Error(`BrainPet DevTools endpoint ${port} did not become ready.`);
}

async function endpointAvailable(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForOutput(chunks, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(chunks.join(""))) return;
    await delay(50);
  }
  throw new Error(`BrainPet did not report the second-instance event.\n${chunks.join("")}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return { code: child.exitCode, timedOut: false };
  return Promise.race([
    new Promise((resolvePromise) => child.once("exit", (code) => resolvePromise({ code, timedOut: false }))),
    delay(timeoutMs).then(() => ({ code: null, timedOut: true })),
  ]);
}

async function stopProcessesForUserDataDir(directory) {
  const script = String.raw`
$needle = '--user-data-dir=' + $env:BRAINPET_SINGLE_INSTANCE_USER_DATA
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  const powershell = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { ...process.env, BRAINPET_SINGLE_INSTANCE_USER_DATA: directory },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  await waitForExit(powershell, 5_000);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
