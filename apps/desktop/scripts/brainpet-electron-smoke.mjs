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
const lifecycleCycles = parsePositiveInteger(process.env.BRAINPET_LIFECYCLE_CYCLES, 1);
const soakMs = parseNonNegativeInteger(process.env.BRAINPET_SOAK_MS, 0);
const startupTimeoutMs = parsePositiveInteger(process.env.BRAINPET_START_TIMEOUT_MS, 20_000);
const expectDisabled = process.env.BRAINPET_EXPECT_DISABLED === "1";
const forcedTask = process.env.BRAINPET_SMOKE_TASK;
const videoPath = process.env.BRAINPET_VIDEO_PATH ? resolve(process.env.BRAINPET_VIDEO_PATH) : null;
if (forcedTask && forcedTask !== "cargo-signal" && forcedTask !== "pack-refresh") throw new Error("BRAINPET_SMOKE_TASK must be cargo-signal or pack-refresh.");

const child = spawn(electronPath, [".", `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`], {
  cwd: appDir,
  env: { ...process.env, ...(!forcedTask ? { OPENPETS_BRAINPET_EXERCISER: "1" } : { OPENPETS_BRAINPET_FORCE_TASK: forcedTask }), OPENPETS_DISABLE_PLUGIN_CATALOG: "1", OPENPETS_LOG_CONSOLE: "1", ...(expectDisabled ? { OPENPETS_BRAINPET_ENABLED: "0" } : {}) },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

try {
  const petTarget = await waitForTarget(port, (target) => target.title === "OpenPets Default Pet", startupTimeoutMs);
  if (expectDisabled) {
    const disabledState = await evaluate(petTarget, `({ triggerFound: Boolean(document.querySelector('[data-brainpet-trigger]')) })`);
    assert.equal(disabledState.triggerFound, false, "feature flag must remove the BrainPet trigger");
    assert.equal((await listTargets(port)).some((target) => target.title === "BrainPet"), false, "feature flag must prevent the stage window");
    process.stdout.write(`${JSON.stringify({ ok: true, featureFlagRollback: true })}\n`);
    process.exitCode = 0;
  } else {
  const openingStartedAt = Date.now();
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

  let stageTarget = await waitForTarget(port, (target) => target.title === "BrainPet", 10_000);
  await waitForEvaluation(stageTarget, `document.readyState === 'complete' && document.body.innerText.includes('开始随机任务')`, 5_000);
  const openingMs = Date.now() - openingStartedAt;
  assert.equal(openingMs <= 500, true, `warm stage opening must stay under 500ms; received ${openingMs}ms`);
  const welcome = await evaluate(stageTarget, `({ width: innerWidth, height: innerHeight, text: document.body.innerText })`);
  assert.equal(welcome.width >= 640 && welcome.width <= 642, true, `stage width must stay within DPI rounding tolerance; received ${welcome.width}`);
  assert.equal(welcome.height >= 360 && welcome.height <= 362, true, `stage height must stay within DPI rounding tolerance; received ${welcome.height}`);
  assert.match(welcome.text, /开始随机任务/);
  await evaluate(stageTarget, `document.querySelector('[data-action="start"]')?.click()`);
  const expectedTaskText = forcedTask === "cargo-signal" ? "装箱，还是放过" : forcedTask === "pack-refresh" ? "行囊不重样" : "舞台校验器";
  await waitForEvaluation(stageTarget, `document.body.innerText.includes(${JSON.stringify(expectedTaskText)})`, 5_000);
  const videoRecording = videoPath ? recordStageVideo(stageTarget, videoPath, 6_000) : null;

  const stagePositionBefore = await evaluate(stageTarget, `({ x: screenX, y: screenY })`);
  const drag = await evaluate(petTarget, `(() => {
    const hitbox = document.querySelector('.pet-hitbox');
    if (!(hitbox instanceof HTMLElement)) return { moved: false };
    const rect = hitbox.getBoundingClientRect();
    const startX = screenX + rect.left + rect.width / 2;
    const startY = screenY + rect.top + rect.height / 2;
    hitbox.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, screenX: startX, screenY: startY }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, screenX: startX - 500, screenY: startY }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, screenX: startX - 500, screenY: startY }));
    return { moved: true };
  })()`);
  assert.equal(drag.moved, true, "pet drag target must exist");
  await delay(1_200);
  const stagePositionAfter = await evaluate(stageTarget, `({ x: screenX, y: screenY })`);
  const anchorFollow = stagePositionAfter.x !== stagePositionBefore.x || stagePositionAfter.y !== stagePositionBefore.y;
  assert.equal(anchorFollow, true, "stage must follow the pet window after it moves");

  await sendCdp(petTarget.webSocketDebuggerUrl, "Page.bringToFront", {});
  await waitForEvaluation(stageTarget, `document.body.innerText.includes('PAUSED')`, 5_000);
  await delay(250);
  await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.bringToFront", {});
  await waitForEvaluation(stageTarget, `!document.body.innerText.includes('PAUSED')`, 5_000);
  const focusPause = true;

  const screenshot = await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", fromSurface: true });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  if (videoRecording) await videoRecording;

  for (let cycle = 1; cycle < lifecycleCycles; cycle += 1) {
    await evaluate(stageTarget, `document.querySelector('[data-action="close"]')?.click()`);
    await waitForTargetToDisappear(port, stageTarget.id, 10_000);
    const currentPetTarget = await waitForTarget(port, (target) => target.title === "OpenPets Default Pet", 5_000);
    await evaluate(currentPetTarget, `document.querySelector('[data-brainpet-trigger]')?.click()`);
    stageTarget = await waitForTarget(port, (target) => target.title === "BrainPet", 10_000);
    await waitForEvaluation(stageTarget, `document.readyState === 'complete' && document.body.innerText.includes('开始随机任务')`, 5_000);
    await evaluate(stageTarget, `document.querySelector('[data-action="start"]')?.click()`);
    await waitForEvaluation(stageTarget, `document.body.innerText.includes(${JSON.stringify(expectedTaskText)})`, 5_000);
  }

  const soak = await runSoak(stageTarget, soakMs);
  if (soakMs >= 60_000) assert.equal(soak.heapGrowthBytes <= 32 * 1024 * 1024, true, `renderer heap grew by ${soak.heapGrowthBytes} bytes during soak`);
  assert.doesNotMatch(logs.join(""), /invalid stage event rejected|stage event transition rejected/, "host must accept every validated session event during smoke and soak");

  try {
    await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.crash", {});
  } catch {
    // Chromium closes the target socket as part of the intentional crash.
  }
  await waitForTargetToDisappear(port, stageTarget.id, 10_000);
  const remainingTargets = await listTargets(port);
  assert.equal(remainingTargets.some((target) => target.title === "OpenPets Default Pet"), true, "stage crash must not close the pet host");

  process.stdout.write(`${JSON.stringify({ ok: true, outputPath, videoPath, trigger, stage: { width: welcome.width, height: welcome.height }, openingMs, anchorFollow, focusPause, lifecycleCycles, soak, crashIsolated: true })}\n`);
  }
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

async function runSoak(target, durationMs) {
  if (durationMs === 0) return { durationMs: 0, samples: 0, sessions: 0, heapGrowthBytes: 0, maxHeapBytes: 0 };
  const startedAt = Date.now();
  let sessions = 1;
  const heapSamples = [];
  while (Date.now() - startedAt < durationMs) {
    const page = await evaluate(target, `({ result: document.body.innerText.includes('本轮完成'), welcome: document.body.innerText.includes('开始随机任务') })`);
    if (page.result) {
      await evaluate(target, `document.querySelector('[data-action="again"]')?.click()`);
      sessions += 1;
    } else if (page.welcome) {
      await evaluate(target, `document.querySelector('[data-action="start"]')?.click()`);
      sessions += 1;
    }
    const heapUsage = await sendCdp(target.webSocketDebuggerUrl, "Runtime.getHeapUsage", {});
    const heap = heapUsage.usedSize;
    if (Number.isFinite(heap)) heapSamples.push(heap);
    await delay(500);
  }
  const warmSamples = heapSamples.slice(Math.min(10, Math.floor(heapSamples.length / 3)));
  if (heapSamples.length < Math.max(10, Math.floor(durationMs / 2_000))) throw new Error(`BrainPet soak collected only ${heapSamples.length} renderer heap samples.`);
  const firstWindow = warmSamples.slice(0, Math.max(1, Math.floor(warmSamples.length / 5)));
  const lastWindow = warmSamples.slice(-Math.max(1, Math.floor(warmSamples.length / 5)));
  return {
    durationMs: Date.now() - startedAt,
    samples: heapSamples.length,
    sessions,
    heapGrowthBytes: Math.round(average(lastWindow) - average(firstWindow)),
    maxHeapBytes: Math.round(Math.max(...heapSamples, 0)),
  };
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

async function recordStageVideo(target, path, durationMs) {
  await mkdir(dirname(path), { recursive: true });
  const frameDirectory = `${path}.frames`;
  await rm(frameDirectory, { recursive: true, force: true });
  await mkdir(frameDirectory, { recursive: true });
  const frameIntervalMs = 100;
  const frameCount = Math.ceil(durationMs / frameIntervalMs);
  for (let index = 0; index < frameCount; index += 1) {
    const screenshot = await sendCdp(target.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", fromSurface: true });
    const framePath = join(frameDirectory, `frame-${String(index + 1).padStart(4, "0")}.png`);
    await writeFile(framePath, Buffer.from(screenshot.data, "base64"));
    await delay(frameIntervalMs);
  }
  const recorder = spawn("ffmpeg", ["-y", "-framerate", String(1000 / frameIntervalMs), "-i", join(frameDirectory, "frame-%04d.png"), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", path], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const errors = [];
  recorder.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  const code = await new Promise((resolvePromise) => recorder.once("exit", resolvePromise));
  await rm(frameDirectory, { recursive: true, force: true });
  if (code !== 0) throw new Error(`BrainPet visual recording failed (${code}).\n${errors.join("")}`);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
