#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createServer } from "node:net";

if (process.platform !== "win32") {
  process.stdout.write(`${JSON.stringify({ skipped: true, reason: "Windows packaged Codex shim smoke" })}\n`);
  process.exit(0);
}

const appRoot = resolve(import.meta.dirname, "..");
const packageRoot = resolve(appRoot, "dist-brainpet", "private-test", "win-unpacked");
const executable = join(packageRoot, "brainpet.exe");
const marketplaceRoot = join(packageRoot, "resources", "integrations", "codex", "brainpet-marketplace");
const root = await mkdtemp(join(tmpdir(), "brainpet-adapter-ui-"));
const userDataPath = join(root, "user-data");
const codexHome = join(root, "codex-home");
const binPath = join(root, "bin");
const markerPath = join(root, "runtime-install.json");
const configPath = join(codexHome, "config.toml");
const port = await reservePort();
await Promise.all([mkdir(userDataPath, { recursive: true }), mkdir(codexHome, { recursive: true }), mkdir(binPath, { recursive: true })]);
await writeFile(configPath, "model = \"fixture\"\r\n", "utf8");
await writeFile(join(codexHome, "fixture-installed.json"), `${JSON.stringify({ installed: [{ pluginId: "brainpet-codex-bridge@brainpet", name: "brainpet-codex-bridge", marketplaceName: "brainpet", version: "0.3.0", installed: true, enabled: true }], available: [] })}\n`, "utf8");
await writeFile(join(codexHome, "fixture-marketplaces.json"), `${JSON.stringify({ marketplaces: [{ name: "brainpet", root: marketplaceRoot }] })}\n`, "utf8");
await writeFile(join(binPath, "codex.cmd"), `@echo off\r\nsetlocal\r\necho %*>>"%CODEX_HOME%\\fixture-commands.log"\r\nif "%~1"=="--version" goto version\r\nif "%~1 %~2 %~3"=="plugin list --json" goto plugin_list\r\nif "%~1 %~2 %~3 %~4"=="plugin marketplace list --json" goto marketplace_list\r\nif "%~1 %~2 %~3"=="plugin marketplace add" goto marketplace_add\r\nif "%~1 %~2 %~3"=="plugin marketplace remove" goto marketplace_remove\r\nif "%~1 %~2"=="plugin add" goto plugin_add\r\nif "%~1 %~2"=="plugin remove" goto plugin_remove\r\ngoto unsupported\r\n:version\r\necho codex-cli 0.147.0\r\nexit /b 0\r\n:plugin_list\r\nif exist "%CODEX_HOME%\\fixture-plugin.enabled" (type "%CODEX_HOME%\\fixture-installed.json") else (echo {"installed":[],"available":[]})\r\nexit /b 0\r\n:marketplace_list\r\nif exist "%CODEX_HOME%\\fixture-marketplace.enabled" (type "%CODEX_HOME%\\fixture-marketplaces.json") else (echo {"marketplaces":[]})\r\nexit /b 0\r\n:marketplace_add\r\necho # marketplace-add>>"%CODEX_HOME%\\config.toml"\r\ntype nul >"%CODEX_HOME%\\fixture-marketplace.enabled"\r\necho {}\r\nexit /b 0\r\n:marketplace_remove\r\necho # marketplace-remove>>"%CODEX_HOME%\\config.toml"\r\ndel /q "%CODEX_HOME%\\fixture-marketplace.enabled" 2>nul\r\necho {}\r\nexit /b 0\r\n:plugin_add\r\necho # plugin-add>>"%CODEX_HOME%\\config.toml"\r\ntype nul >"%CODEX_HOME%\\fixture-plugin.enabled"\r\necho {}\r\nexit /b 0\r\n:plugin_remove\r\necho # plugin-remove>>"%CODEX_HOME%\\config.toml"\r\ndel /q "%CODEX_HOME%\\fixture-plugin.enabled" 2>nul\r\necho {}\r\nexit /b 0\r\n:unsupported\r\necho unsupported fixture command 1>&2\r\nexit /b 2\r\n`, "utf8");

const logs = [];
const child = spawn(executable, [`--user-data-dir=${userDataPath}`, `--remote-debugging-port=${port}`, "--brainpet-open-setup-guide"], {
  cwd: packageRoot,
  env: {
    ...process.env,
    PATH: `${binPath}${delimiter}${process.env.PATH ?? ""}`,
    CODEX_HOME: codexHome,
    BRAINPET_INSTALL_MARKER_FILE: markerPath,
    OPENPETS_DISABLE_PLUGIN_CATALOG: "1",
    OPENPETS_LOG_CONSOLE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

try {
  const target = await waitForTarget(port, (candidate) => candidate.url.includes("brainpet-setup.html"), 20_000);
  await waitForEvaluation(target, `document.getElementById('bridge-status')?.textContent?.includes('CONNECT') || document.getElementById('bridge-status')?.textContent?.includes('连接')`, 10_000);
  await evaluate(target, `document.getElementById('bridge-status').click()`);
  await waitForEvaluation(target, `document.getElementById('bridge-status')?.textContent?.includes('CONNECTED') || document.getElementById('bridge-status')?.textContent?.includes('已连接')`, 15_000);
  const connectReceipt = JSON.parse(await readFile(join(userDataPath, "adapter-receipts", "codex-latest.json"), "utf8"));
  assert.equal(connectReceipt.operation, "install");
  assert.equal(connectReceipt.status, "succeeded");
  assert.equal(connectReceipt.installedSelector, "brainpet-codex-bridge@brainpet");
  await evaluate(target, `document.getElementById('disconnect').click()`);
  await waitForEvaluation(target, `document.getElementById('disconnect')?.classList.contains('hidden') && !document.getElementById('bridge-status')?.textContent?.includes('CONNECTED') && !document.getElementById('bridge-status')?.textContent?.includes('已连接')`, 15_000);
  const uninstallReceipt = JSON.parse(await readFile(join(userDataPath, "adapter-receipts", "codex-latest.json"), "utf8"));
  assert.equal(uninstallReceipt.operation, "uninstall");
  assert.equal(uninstallReceipt.status, "succeeded");
  const backups = (await readdir(join(userDataPath, "adapter-backups"))).filter((name) => name.endsWith(".toml"));
  assert.equal(backups.length, 2);
  assert.equal((await readFile(configPath, "utf8")).includes("model = \"fixture\""), true);
  process.stdout.write(`${JSON.stringify({ packagedSetup: true, install: "succeeded", uninstall: "succeeded", backups: backups.length, realCodexConfigTouched: false })}\n`);
} catch (error) {
  process.stderr.write(`${logs.join("")}\n`);
  process.stderr.write(`fixture commands:\n${await readFile(join(codexHome, "fixture-commands.log"), "utf8").catch(() => "(none)")}\n`);
  throw error;
} finally {
  child.kill();
  await waitForExit(child, 5_000);
  await stopProcessesForUserDataDir(userDataPath);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const selected = address.port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return selected;
}

async function listTargets(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1_000) });
  if (!response.ok) throw new Error(`Electron DevTools endpoint returned ${response.status}.`);
  return response.json();
}

async function waitForTarget(debugPort, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      lastTargets = await listTargets(debugPort);
      const target = lastTargets.find(predicate);
      if (target) return target;
    } catch { /* packaged app is still starting */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for the BrainPet setup window: ${JSON.stringify(lastTargets.map((target) => ({ title: target.title, url: target.url })))}`);
}

async function evaluate(target, expression) {
  const response = await sendCdp(target.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "BrainPet setup evaluation failed.");
  return response.result?.value;
}

async function waitForEvaluation(target, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(target, expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for setup expression: ${expression}`);
}

function sendCdp(webSocketUrl, method, params) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP command timed out: ${method}`));
    }, 10_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolvePromise(message.result);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`CDP socket failed: ${method}`));
    });
  });
}

async function stopProcessesForUserDataDir(directory) {
  const script = String.raw`
$needle = '--user-data-dir=' + $env:BRAINPET_ADAPTER_UI_USER_DATA
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  const powershell = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { ...process.env, BRAINPET_ADAPTER_UI_USER_DATA: directory },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  await waitForExit(powershell, 5_000);
}

function waitForExit(process, timeoutMs) {
  if (process.exitCode !== null) return Promise.resolve();
  return Promise.race([new Promise((resolvePromise) => process.once("exit", resolvePromise)), delay(timeoutMs)]);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
