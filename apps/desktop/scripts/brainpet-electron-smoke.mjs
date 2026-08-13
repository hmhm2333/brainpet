#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const repoRoot = resolve(appDir, "..", "..");
const outputPath = resolve(process.argv[2] ?? join(repoRoot, "output", "playwright", "brainpet-electron-stage.png"));
const require = createRequire(import.meta.url);
const electronPath = process.env.BRAINPET_ELECTRON_EXECUTABLE || require("electron");
const userDataDir = await mkdtemp(join(tmpdir(), "brainpet-electron-smoke-"));
const port = await reservePort();
const logs = [];

const child = spawn(electronPath, [".", `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`], {
  cwd: appDir,
  env: { ...process.env, OPENPETS_BRAINPET_EXERCISER: "1", OPENPETS_DISABLE_PLUGIN_CATALOG: "1", OPENPETS_LOG_CONSOLE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

try {
  const petTarget = await waitForTarget(port, (target) => target.title === "OpenPets Default Pet", 20_000);
  const trigger = await evaluate(petTarget, `(() => {
    const button = document.querySelector('[data-brainpet-trigger]');
    if (!(button instanceof HTMLButtonElement)) return { found: false };
    const rect = button.getBoundingClientRect();
    button.click();
    return { found: true, label: button.getAttribute('aria-label'), width: rect.width, height: rect.height };
  })()`);
  assert.equal(trigger.found, true, "pet training trigger must exist");
  assert.equal(trigger.label, "打开 BrainPet 训练");
  assert.equal(trigger.width >= 28 && trigger.height >= 28, true, "pet training trigger must remain easy to click");

  const stageTarget = await waitForTarget(port, (target) => target.title === "BrainPet", 10_000);
  const welcome = await evaluate(stageTarget, `({ width: innerWidth, height: innerHeight, text: document.body.innerText })`);
  assert.equal(welcome.width >= 640 && welcome.width <= 642, true, `stage width must stay within DPI rounding tolerance; received ${welcome.width}`);
  assert.equal(welcome.height >= 360 && welcome.height <= 362, true, `stage height must stay within DPI rounding tolerance; received ${welcome.height}`);
  assert.match(welcome.text, /开始随机任务/);
  await evaluate(stageTarget, `document.querySelector('[data-action="start"]')?.click()`);
  await waitForEvaluation(stageTarget, `document.body.innerText.includes('舞台校验器')`, 5_000);

  const screenshot = await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", fromSurface: true });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));

  try {
    await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.crash", {});
  } catch {
    // Chromium closes the target socket as part of the intentional crash.
  }
  await waitForTargetToDisappear(port, stageTarget.id, 10_000);
  const remainingTargets = await listTargets(port);
  assert.equal(remainingTargets.some((target) => target.title === "OpenPets Default Pet"), true, "stage crash must not close the pet host");

  process.stdout.write(`${JSON.stringify({ ok: true, outputPath, trigger, stage: { width: welcome.width, height: welcome.height }, crashIsolated: true })}\n`);
} catch (error) {
  process.stderr.write(`${logs.join("")}\n`);
  throw error;
} finally {
  child.kill();
  await waitForExit(child, 5_000);
  await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const selected = address.port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return selected;
}

async function listTargets(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!response.ok) throw new Error(`Electron DevTools endpoint returned ${response.status}.`);
  return response.json();
}

async function waitForTarget(debugPort, predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const target = (await listTargets(debugPort)).find(predicate);
      if (target) return target;
    } catch {
      // Electron has not opened its debugging endpoint yet.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Electron target.");
}

async function waitForTargetToDisappear(debugPort, targetId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await listTargets(debugPort)).some((target) => target.id === targetId)) return;
    await delay(100);
  }
  throw new Error("Crashed BrainPet stage target did not close.");
}

async function evaluate(target, expression) {
  const response = await sendCdp(target.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "Electron evaluation failed.");
  return response.result?.value;
}

async function waitForEvaluation(target, expression, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(target, expression)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for expression: ${expression}`);
}

function sendCdp(webSocketUrl, method, params) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const id = 1;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP command timed out: ${method}`));
    }, 10_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id, method, params })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
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

function waitForExit(process, timeoutMs) {
  if (process.exitCode !== null) return Promise.resolve();
  return Promise.race([new Promise((resolvePromise) => process.once("exit", resolvePromise)), delay(timeoutMs)]);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
