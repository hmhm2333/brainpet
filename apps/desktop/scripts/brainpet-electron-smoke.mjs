#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const spawnedAt = Date.now();
const lifecycleCycles = parsePositiveInteger(process.env.BRAINPET_LIFECYCLE_CYCLES, 1);
const soakMs = parseNonNegativeInteger(process.env.BRAINPET_SOAK_MS, 0);
const startupTimeoutMs = parsePositiveInteger(process.env.BRAINPET_START_TIMEOUT_MS, 20_000);
const expectDisabled = process.env.BRAINPET_EXPECT_DISABLED === "1";
const verifyCompletion = process.env.BRAINPET_VERIFY_COMPLETION === "1";
const skipFocusPause = process.env.BRAINPET_SKIP_FOCUS_PAUSE === "1";
const forcedTask = process.env.BRAINPET_SMOKE_TASK;
const videoPath = process.env.BRAINPET_VIDEO_PATH ? resolve(process.env.BRAINPET_VIDEO_PATH) : null;
if (forcedTask && forcedTask !== "cargo-signal" && forcedTask !== "pack-refresh") throw new Error("BRAINPET_SMOKE_TASK must be cargo-signal or pack-refresh.");

const child = spawn(electronPath, [".", `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`], {
  cwd: appDir,
  env: { ...process.env, ...(!forcedTask ? { OPENPETS_BRAINPET_EXERCISER: "1" } : { OPENPETS_BRAINPET_FORCE_TASK: forcedTask }), OPENPETS_DISTRIBUTION_PROFILE: process.env.OPENPETS_DISTRIBUTION_PROFILE ?? "brainpet", OPENPETS_DISABLE_PLUGIN_CATALOG: "1", OPENPETS_LOG_CONSOLE: "1", ...(expectDisabled ? { OPENPETS_BRAINPET_ENABLED: "0" } : {}) },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

try {
  const petTarget = await waitForTarget(port, (target) => target.title === "OpenPets Default Pet", startupTimeoutMs);
  const petReadyMs = Date.now() - spawnedAt;
  await delay(500);
  const idleProcessMetrics = process.platform === "win32" ? await measureProcessesForUserDataDir(userDataDir) : null;
  if (expectDisabled) {
    const disabledState = await evaluate(petTarget, `({ triggerFound: Boolean(document.querySelector('[data-brainpet-trigger]')) })`);
    assert.equal(disabledState.triggerFound, false, "feature flag must remove the BrainPet trigger");
    assert.equal((await listTargets(port)).some((target) => target.title === "BrainPet"), false, "feature flag must prevent the stage window");
    process.stdout.write(`${JSON.stringify({ ok: true, featureFlagRollback: true })}\n`);
    process.exitCode = 0;
  } else {
  const trigger = await evaluate(petTarget, `(() => {
    const button = document.querySelector('[data-brainpet-trigger]');
    if (!(button instanceof HTMLButtonElement)) return { found: false };
    const rect = button.getBoundingClientRect();
    return { found: true, label: button.getAttribute('aria-label'), width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight, screenX, screenY, xRatio: (rect.left + rect.width / 2) / innerWidth, yRatio: (rect.top + rect.height / 2) / innerHeight };
  })()`);
  logs.push(`BrainPet trigger geometry ${JSON.stringify(trigger)}\n`);
  assert.equal(trigger.found, true, "pet training trigger must exist");
  assert.equal(trigger.label, "打开 BrainPet 训练");
  assert.equal(trigger.width >= 28 && trigger.height >= 28, true, "pet training trigger must remain easy to click");
  const clickedAtMs = await clickPetTrigger(petTarget, trigger);
  await waitForEvaluation(petTarget, `document.documentElement.dataset.brainpetLaunching === 'true'`, 500);

  let stageTarget = await waitForTarget(port, (target) => target.title === "BrainPet", 10_000);
  const expectedTaskText = forcedTask === "cargo-signal" ? "装箱，还是放过" : forcedTask === "pack-refresh" ? "行囊不重样" : "舞台校验器";
  await waitForEvaluation(stageTarget, `document.readyState === 'complete' && document.body.innerText.includes(${JSON.stringify(expectedTaskText)})`, 5_000);
  const openingMs = Date.now() - clickedAtMs;
  assert.equal(openingMs <= 500, true, `warm stage opening must stay under 500ms; received ${openingMs}ms`);
  const welcome = await evaluate(stageTarget, `({ width: innerWidth, height: innerHeight, text: document.body.innerText, hasSelectionButton: Boolean(document.querySelector('[data-action="start"]')) })`);
  assert.equal(welcome.width >= 640 && welcome.width <= 642, true, `stage width must stay within DPI rounding tolerance; received ${welcome.width}`);
  assert.equal(welcome.height >= 360 && welcome.height <= 362, true, `stage height must stay within DPI rounding tolerance; received ${welcome.height}`);
  assert.equal(welcome.hasSelectionButton, false, "stage must auto-enter the selected task without a lobby button");
  const introOutputPath = outputPath.replace(/(\.[^.]+)$/, "-intro$1");
  const introScreenshot = await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", fromSurface: true });
  await mkdir(dirname(introOutputPath), { recursive: true });
  await writeFile(introOutputPath, Buffer.from(introScreenshot.data, "base64"));
  await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.task-card'))`, 5_000);
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

  let focusPause = false;
  if (!verifyCompletion && !skipFocusPause) {
    await sendCdp(petTarget.webSocketDebuggerUrl, "Page.bringToFront", {});
    await waitForEvaluation(stageTarget, `document.body.innerText.includes('PAUSED')`, 5_000);
    await delay(250);
    await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.bringToFront", {});
    await waitForEvaluation(stageTarget, `!document.body.innerText.includes('PAUSED')`, 5_000);
    focusPause = true;
  }

  const screenshot = await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", fromSurface: true });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  if (videoRecording) await videoRecording;

  let completion = null;
  let resultOutputPath = null;
  if (verifyCompletion) {
    assert.equal(forcedTask, "cargo-signal", "completion smoke currently requires the deterministic cargo-signal task");
    // Visual capture and anchor movement can suspend rAF in Chromium. Start a clean
    // measured session so the quality gate reflects play rather than CDP tooling.
    await evaluate(stageTarget, `document.querySelector('[data-action="close"]')?.click()`);
    await waitForTargetToDisappear(port, stageTarget.id, 10_000);
    await evaluate(petTarget, `document.querySelector('[data-brainpet-trigger]')?.click()`);
    stageTarget = await waitForTarget(port, (target) => target.title === "BrainPet", 10_000);
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.task-card'))`, 5_000);
    await evaluate(stageTarget, `window.__brainPetAutoInput = window.setInterval(() => { const target = document.querySelector('.tone-sky [data-action="primary"]'); if (target instanceof HTMLElement) target.click(); }, 60)`);
    // Avoid opening a fresh CDP socket 20 times per second during the measured
    // session; that instrumentation itself creates artificial 300-500 ms gaps.
    await delay(44_000);
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.result-card'))`, 12_000);
    await evaluate(stageTarget, `window.clearInterval(window.__brainPetAutoInput)`);
    await waitForEvaluation(stageTarget, `!document.body.innerText.includes('CHECKING...')`, 5_000);
    completion = await evaluate(stageTarget, `({ text: document.body.innerText, hasRetry: Boolean(document.querySelector('[data-action="again"]')) })`);
    await delay(250);
    const persisted = JSON.parse(await readFile(join(userDataDir, "brainpet-state.json"), "utf8"));
    completion.quality = persisted.recentResults?.[0]?.quality ?? null;
    assert.match(completion.text, /今日已完成 1 关/);
    assert.equal(completion.quality?.valid, true, `completion quality must be valid: ${JSON.stringify(completion.quality)}`);
    assert.match(completion.text, /QUEST CLEAR!/);
    assert.doesNotMatch(completion.text, /成绩不计有效/);
    assert.equal(completion.hasRetry, true, "result must offer a same-level retry");
    await delay(1_500);
    completion.layout = await evaluate(stageTarget, `(() => {
      const content = document.querySelector('.result-content');
      if (!(content instanceof HTMLElement)) return null;
      const container = content.getBoundingClientRect();
      const selectors = ['.pixel-kicker', '.score-medal', '.best-score', '.daily-stamp', '.agent-notice', '.result-stats', '.quality-note', '.result-actions', '.auto-close'];
      const items = selectors.flatMap((selector) => {
        const element = content.querySelector(selector);
        if (!(element instanceof HTMLElement)) return [];
        const rect = element.getBoundingClientRect();
        return [{ selector, top: rect.top, bottom: rect.bottom, height: rect.height }];
      });
      return { top: container.top, bottom: container.bottom, items };
    })()`);
    assert.ok(completion.layout, "result layout must exist");
    for (const item of completion.layout.items) {
      assert.equal(item.height > 0, true, `${item.selector} must not collapse`);
      assert.equal(item.top >= completion.layout.top - 1 && item.bottom <= completion.layout.bottom + 1, true, `${item.selector} must remain inside the result surface`);
    }
    for (let index = 1; index < completion.layout.items.length; index += 1) {
      assert.equal(completion.layout.items[index].top >= completion.layout.items[index - 1].bottom - 1, true, `${completion.layout.items[index].selector} must not overlap the previous result row`);
    }
    resultOutputPath = outputPath.replace(/(\.[^.]+)$/, "-result$1");
    const resultScreenshot = await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(resultOutputPath, Buffer.from(resultScreenshot.data, "base64"));
    await evaluate(stageTarget, `document.querySelector('[data-action="again"]')?.click()`);
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.task-card')) && document.body.innerText.includes('第 1 关')`, 5_000);
    await sendCdp(petTarget.webSocketDebuggerUrl, "Page.bringToFront", {});
    await waitForEvaluation(stageTarget, `document.body.innerText.includes('PAUSED')`, 5_000);
    await delay(250);
    await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.bringToFront", {});
    await waitForEvaluation(stageTarget, `!document.body.innerText.includes('PAUSED')`, 5_000);
    focusPause = true;
  }

  for (let cycle = 1; cycle < lifecycleCycles; cycle += 1) {
    await evaluate(stageTarget, `document.querySelector('[data-action="close"]')?.click()`);
    await waitForTargetToDisappear(port, stageTarget.id, 10_000);
    const currentPetTarget = await waitForTarget(port, (target) => target.title === "OpenPets Default Pet", 5_000);
    await evaluate(currentPetTarget, `document.querySelector('[data-brainpet-trigger]')?.click()`);
    stageTarget = await waitForTarget(port, (target) => target.title === "BrainPet", 10_000);
    await waitForEvaluation(stageTarget, `document.readyState === 'complete' && document.body.innerText.includes(${JSON.stringify(expectedTaskText)})`, 5_000);
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.task-card'))`, 5_000);
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

  process.stdout.write(`${JSON.stringify({ ok: true, outputPath, introOutputPath, resultOutputPath, videoPath, petReadyMs, idleProcessMetrics, trigger, stage: { width: welcome.width, height: welcome.height }, openingMs, anchorFollow, focusPause, completionVerified: Boolean(completion), completionQuality: completion?.quality ?? null, lifecycleCycles, soak, crashIsolated: true })}\n`);
  }
} catch (error) {
  process.stderr.write(`${logs.join("")}\n`);
  throw error;
} finally {
  await closeElectronApp(port);
  child.kill();
  await waitForExit(child, 5_000);
  if (process.platform === "win32") await stopProcessesForUserDataDir(userDataDir);
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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

async function clickPetTrigger(petTarget, trigger) {
  if (process.platform !== "win32") {
    const x = trigger.xRatio * trigger.viewportWidth;
    const y = trigger.yRatio * trigger.viewportHeight;
    await sendCdp(petTarget.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sendCdp(petTarget.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sendCdp(petTarget.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return Date.now();
  }

  const script = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BrainPetNativePointer {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static IntPtr FindBestWindow(int[] processIds, int expectedLeft, int expectedTop, int expectedWidth, int expectedHeight) {
    var ids = new System.Collections.Generic.HashSet<int>(processIds);
    IntPtr best = IntPtr.Zero;
    long bestScore = long.MaxValue;
    EnumWindows((hwnd, _) => {
      uint processId;
      GetWindowThreadProcessId(hwnd, out processId);
      Rect rect;
      if (!ids.Contains((int)processId) || !IsWindowVisible(hwnd) || !GetWindowRect(hwnd, out rect)) return true;
      var width = rect.Right - rect.Left;
      var height = rect.Bottom - rect.Top;
      var score = Math.Abs(rect.Left - expectedLeft) + Math.Abs(rect.Top - expectedTop) + Math.Abs(width - expectedWidth) + Math.Abs(height - expectedHeight);
      if (score < bestScore) { best = hwnd; bestScore = score; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static bool PostLeftClick(IntPtr hwnd, int clientX, int clientY) {
    var point = new IntPtr((clientY << 16) | (clientX & 0xffff));
    return PostMessage(hwnd, 0x0201, new IntPtr(1), point) && PostMessage(hwnd, 0x0202, IntPtr.Zero, point);
  }
}
'@
[BrainPetNativePointer]::SetProcessDPIAware() | Out-Null
$handle = [BrainPetNativePointer]::FindWindow($null, $env:BRAINPET_NATIVE_WINDOW_TITLE)
if ($handle -eq [IntPtr]::Zero) {
  $needle = '--user-data-dir=' + $env:BRAINPET_NATIVE_USER_DATA
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine)
  $roots = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  $ids = [System.Collections.Generic.HashSet[uint32]]::new()
  foreach ($root in $roots) { [void]$ids.Add([uint32]$root.ProcessId) }
  do {
    $changed = $false
    foreach ($process in $all) {
      if ($ids.Contains([uint32]$process.ParentProcessId) -and $ids.Add([uint32]$process.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  [int[]]$processIds = @($ids | ForEach-Object { [int]$_ })
  $handle = [BrainPetNativePointer]::FindBestWindow($processIds, [int]$env:BRAINPET_NATIVE_SCREEN_X, [int]$env:BRAINPET_NATIVE_SCREEN_Y, [int]$env:BRAINPET_NATIVE_VIEWPORT_WIDTH, [int]$env:BRAINPET_NATIVE_VIEWPORT_HEIGHT)
}
if ($handle -eq [IntPtr]::Zero) { throw 'BrainPet pet window was not found in its isolated Electron process tree.' }
$rect = New-Object BrainPetNativePointer+Rect
if (-not [BrainPetNativePointer]::GetWindowRect($handle, [ref]$rect)) { throw 'BrainPet pet window bounds were unavailable.' }
$x = [Math]::Round($rect.Left + ($rect.Right - $rect.Left) * [double]$env:BRAINPET_NATIVE_X_RATIO)
$y = [Math]::Round($rect.Top + ($rect.Bottom - $rect.Top) * [double]$env:BRAINPET_NATIVE_Y_RATIO)
if (-not [BrainPetNativePointer]::SetCursorPos($x, $y)) { throw 'BrainPet could not move the native cursor to its trigger.' }
[BrainPetNativePointer]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 350
[BrainPetNativePointer]::SetCursorPos($x + 1, $y) | Out-Null
Start-Sleep -Milliseconds 80
[BrainPetNativePointer]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 80
$clientX = [Math]::Round(($rect.Right - $rect.Left) * [double]$env:BRAINPET_NATIVE_X_RATIO)
$clientY = [Math]::Round(($rect.Bottom - $rect.Top) * [double]$env:BRAINPET_NATIVE_Y_RATIO)
if (-not [BrainPetNativePointer]::PostLeftClick($handle, $clientX, $clientY)) { throw 'BrainPet native window click message failed.' }
Write-Output ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
`;
  const output = await runPowerShell(script, {
    BRAINPET_NATIVE_WINDOW_TITLE: "OpenPets Default Pet",
    BRAINPET_NATIVE_USER_DATA: userDataDir,
    BRAINPET_NATIVE_SCREEN_X: String(trigger.screenX),
    BRAINPET_NATIVE_SCREEN_Y: String(trigger.screenY),
    BRAINPET_NATIVE_VIEWPORT_WIDTH: String(trigger.viewportWidth),
    BRAINPET_NATIVE_VIEWPORT_HEIGHT: String(trigger.viewportHeight),
    BRAINPET_NATIVE_X_RATIO: String(trigger.xRatio),
    BRAINPET_NATIVE_Y_RATIO: String(trigger.yRatio),
  });
  const clickedAtMs = Number.parseInt(output.trim().split(/\r?\n/).at(-1) ?? "", 10);
  if (!Number.isFinite(clickedAtMs)) throw new Error(`BrainPet native pointer did not report a click timestamp.\n${output}`);
  return clickedAtMs;
}

async function closeElectronApp(debugPort) {
  try {
    const target = (await listTargets(debugPort))[0];
    if (target?.webSocketDebuggerUrl) await sendCdp(target.webSocketDebuggerUrl, "Browser.close", {});
  } catch {
    // The app may already have exited after a failed startup.
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    try {
      await listTargets(debugPort);
    } catch {
      return;
    }
    await delay(100);
  }
}

async function stopProcessesForUserDataDir(directory) {
  const script = String.raw`
$needle = '--user-data-dir=' + $env:BRAINPET_CLEANUP_USER_DATA
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine)
$roots = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
if ($roots.Count -eq 0) { exit 0 }
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
foreach ($root in $roots) { [void]$ids.Add([uint32]$root.ProcessId) }
do {
  $changed = $false
  foreach ($process in $all) {
    if ($ids.Contains([uint32]$process.ParentProcessId) -and $ids.Add([uint32]$process.ProcessId)) { $changed = $true }
  }
} while ($changed)
foreach ($id in @($ids) | Sort-Object -Descending) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 300
$remaining = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
if ($remaining.Count -gt 0) { throw "BrainPet smoke cleanup left $($remaining.Count) process roots running." }
`;
  await runPowerShell(script, { BRAINPET_CLEANUP_USER_DATA: directory });
}

async function measureProcessesForUserDataDir(directory) {
  const script = String.raw`
$needle = '--user-data-dir=' + $env:BRAINPET_METRICS_USER_DATA
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, WorkingSetSize, PrivatePageCount)
$roots = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
foreach ($root in $roots) { [void]$ids.Add([uint32]$root.ProcessId) }
do {
  $changed = $false
  foreach ($process in $all) {
    if ($ids.Contains([uint32]$process.ParentProcessId) -and $ids.Add([uint32]$process.ProcessId)) { $changed = $true }
  }
} while ($changed)
$selected = @($all | Where-Object { $ids.Contains([uint32]$_.ProcessId) })
$workingSet = ($selected | Measure-Object WorkingSetSize -Sum).Sum
$privateBytes = ($selected | Measure-Object PrivatePageCount -Sum).Sum
[pscustomobject]@{
  processCount = $selected.Count
  workingSetBytes = [int64]$workingSet
  privateBytes = [int64]$privateBytes
  names = @($selected | Group-Object Name | ForEach-Object { $_.Name + ':' + $_.Count })
} | ConvertTo-Json -Compress
`;
  const output = await runPowerShell(script, { BRAINPET_METRICS_USER_DATA: directory });
  return JSON.parse(output.trim());
}

function runPowerShell(script, extraEnv) {
  return new Promise((resolvePromise, reject) => {
    const powershell = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = [];
    powershell.stdout?.on("data", (chunk) => output.push(String(chunk)));
    powershell.stderr?.on("data", (chunk) => output.push(String(chunk)));
    powershell.once("error", reject);
    powershell.once("exit", (code) => code === 0 ? resolvePromise(output.join("")) : reject(new Error(`PowerShell helper failed (${code}).\n${output.join("")}`)));
  });
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
    const page = await evaluate(target, `({ result: Boolean(document.querySelector('.result-card')), intro: Boolean(document.querySelector('.intro-card')) })`);
    if (page.result) {
      await evaluate(target, `document.querySelector('[data-action="again"]')?.click()`);
      sessions += 1;
    } else if (page.intro) {
      await evaluate(target, `document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))`);
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
