#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createOpenPetsClient } from "../../../packages/client/dist/index.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const repoRoot = resolve(appDir, "..", "..");
const outputPath = resolve(process.argv[2] ?? join(repoRoot, "output", "playwright", "brainpet-electron-stage.png"));
const require = createRequire(import.meta.url);
const electronPath = process.env.BRAINPET_ELECTRON_EXECUTABLE || require("electron");
const userDataDir = await mkdtemp(join(tmpdir(), "brainpet-electron-smoke-"));
const discoveryPath = join(userDataDir, "brainpet-ipc.json");
const installMarkerPath = join(userDataDir, "runtime-install.json");
const port = await reservePort();
const logs = [];
const spawnedAt = Date.now();
const lifecycleCycles = parsePositiveInteger(process.env.BRAINPET_LIFECYCLE_CYCLES, 1);
const soakMs = parseNonNegativeInteger(process.env.BRAINPET_SOAK_MS, 0);
const startupTimeoutMs = parsePositiveInteger(process.env.BRAINPET_START_TIMEOUT_MS, 20_000);
const expectDisabled = process.env.BRAINPET_EXPECT_DISABLED === "1";
const verifyOpenPetsIsolation = process.env.BRAINPET_EXPECT_OPENPETS_ISOLATION === "1";
const verifyCompletion = process.env.BRAINPET_VERIFY_COMPLETION === "1";
const skipFocusPause = process.env.BRAINPET_SKIP_FOCUS_PAUSE === "1";
const forcedTask = process.env.BRAINPET_SMOKE_TASK;
const enforceResourceBudget = !verifyOpenPetsIsolation && process.env.BRAINPET_ENFORCE_RESOURCE_BUDGET !== "0";
const videoPath = process.env.BRAINPET_VIDEO_PATH ? resolve(process.env.BRAINPET_VIDEO_PATH) : null;
if (forcedTask && forcedTask !== "cargo-signal" && forcedTask !== "pack-refresh" && forcedTask !== "foundation-probe") throw new Error("BRAINPET_SMOKE_TASK must be cargo-signal, pack-refresh, or foundation-probe.");
if (expectDisabled && verifyOpenPetsIsolation) throw new Error("Rollback and OpenPets isolation smoke modes are mutually exclusive.");
if (verifyOpenPetsIsolation && process.env.OPENPETS_DISTRIBUTION_PROFILE !== "openpets") throw new Error("OpenPets isolation smoke requires OPENPETS_DISTRIBUTION_PROFILE=openpets.");

const exerciserMode = !forcedTask || forcedTask === "foundation-probe";
const petWindowTitle = verifyOpenPetsIsolation ? "OpenPets Default Pet" : "BrainPet Default Pet";

const child = spawn(electronPath, [".", `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`], {
  cwd: appDir,
  env: { ...process.env, ...(exerciserMode ? { OPENPETS_BRAINPET_EXERCISER: "1" } : {}), ...(forcedTask ? { OPENPETS_BRAINPET_FORCE_TASK: forcedTask } : {}), OPENPETS_DISTRIBUTION_PROFILE: process.env.OPENPETS_DISTRIBUTION_PROFILE ?? "brainpet", OPENPETS_DISCOVERY_FILE: discoveryPath, BRAINPET_INSTALL_MARKER_FILE: installMarkerPath, OPENPETS_DISABLE_PLUGIN_CATALOG: "1", OPENPETS_LOG_CONSOLE: "1", ...(expectDisabled ? { BRAINPET_ENABLED: "0" } : {}) },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

try {
  let petTarget = await waitForTarget(port, (target) => target.title === petWindowTitle, startupTimeoutMs);
  const petReadyMs = Date.now() - spawnedAt;
  await delay(500);
  const coldRendererTargets = (await listTargets(port)).filter((target) => target.type === "page");
  assert.deepEqual(coldRendererTargets.map((target) => target.title), [petWindowTitle], `cold BrainPet must own only the pet renderer: ${JSON.stringify(coldRendererTargets.map(({ title, url }) => ({ title, url })))}`);
  assert.equal(coldRendererTargets.some((target) => /plugin|control.?center/i.test(`${target.title} ${target.url}`)), false, "cold BrainPet must not create a Control Center or hidden plugin renderer");
  // Cold idle is a steady-state budget. Give the visible pet enough time to
  // fault in its animation/font pages before taking the baseline used by the
  // later hot-idle delta; startup latency remains the earlier petReadyMs.
  await delay(15_000);
  const idleProcessMetrics = process.platform === "win32" ? await measureProcessesForUserDataDir(userDataDir) : null;
  if (idleProcessMetrics) process.stdout.write(`BRAINPET_RESOURCE_METRICS ${JSON.stringify({ phase: "cold-idle", metrics: idleProcessMetrics })}\n`);
  if (enforceResourceBudget && idleProcessMetrics) assertProcessBudget("idle", idleProcessMetrics, { processCount: 5, workingSetBytes: 400 * 1024 * 1024, privateBytes: 400 * 1024 * 1024 });
  if (verifyOpenPetsIsolation) {
    const openPetsRender = await evaluate(petTarget, `(() => {
      const sprite = document.querySelector('.sprite');
      if (!(sprite instanceof HTMLElement)) return null;
      const style = getComputedStyle(sprite);
      return { backgroundImage: style.backgroundImage, animationName: style.animationName, triggerFound: Boolean(document.querySelector('[data-brainpet-trigger]')) };
    })()`);
    assert.match(openPetsRender?.backgroundImage ?? "", /default-pet-spritesheet\.webp/, "OpenPets must retain its normal animated spritesheet");
    assert.notEqual(openPetsRender?.animationName, "none", "OpenPets must not enter BrainPet post-training static idle");
    assert.equal(openPetsRender?.triggerFound, false, "OpenPets must not expose the BrainPet training trigger");
    await delay(2_000);
    const openPetsTargets = await listTargets(port);
    assert.equal(openPetsTargets.some((target) => target.id === petTarget.id && target.title === petWindowTitle), true, "OpenPets pet renderer must not be replaced by BrainPet recovery behavior");
    assert.equal(openPetsTargets.some((target) => target.title === "BrainPet"), false, "OpenPets must not create a BrainPet stage renderer");
    process.stdout.write(`${JSON.stringify({ ok: true, openPetsProfileIsolation: true, animatedPetPreserved: true, rendererId: petTarget.id })}\n`);
    process.exitCode = 0;
  } else if (expectDisabled) {
    const disabledState = await evaluate(petTarget, `({ triggerFound: Boolean(document.querySelector('[data-brainpet-trigger]')) })`);
    assert.equal(disabledState.triggerFound, false, "feature flag must remove the BrainPet trigger");
    assert.equal((await listTargets(port)).some((target) => target.title === "BrainPet"), false, "feature flag must prevent the stage window");
    const rollbackClient = createOpenPetsClient({ target: "brainpet", discoveryPath });
    await assert.rejects(
      rollbackClient.reportAgentActivity({ schemaVersion: 1, agent: "codex", sessionId: "rollback-probe", state: "working", occurredAt: Date.now(), capabilities: ["observeLifecycle"] }),
      /disabled|unsupported/i,
      "feature flag rollback must reject lifecycle ingestion instead of hiding only the UI",
    );
    assert.equal(await evaluate(petTarget, `Boolean(document.querySelector('[data-companion-toggle]'))`), false, "feature flag rollback must not render Agent lifecycle UI");
    await assert.rejects(readFile(installMarkerPath), /ENOENT/, "feature flag rollback must not refresh the packaged install marker");
    process.stdout.write(`${JSON.stringify({ ok: true, featureFlagRollback: true, lifecycleRejected: true })}\n`);
    process.exitCode = 0;
  } else {
  const companionClient = createOpenPetsClient({ target: "brainpet", discoveryPath });
  const companionNow = Date.now();
  await companionClient.reportAgentActivity({ schemaVersion: 1, agent: "codex", sessionId: "smoke-working", turnId: "turn-working", state: "working", occurredAt: companionNow, capabilities: ["observeLifecycle"] });
  await companionClient.reportAgentActivity({ schemaVersion: 1, agent: "claude", sessionId: "smoke-review", turnId: "turn-review", state: "waiting", occurredAt: companionNow + 1, capabilities: ["observeLifecycle", "respondToRequest"], request: { kind: "permission", requestId: "smoke-request", options: [{ id: "once", label: "Allow once", intent: "runOnce" }, { id: "deny", label: "Deny", intent: "deny" }] } });
  await waitForEvaluation(petTarget, `Boolean(document.querySelector('[data-companion-toggle]'))`, 2_000);
  const companionBadge = await evaluate(petTarget, `(() => {
    const button = document.querySelector('[data-companion-toggle]');
    if (!(button instanceof HTMLButtonElement)) return { found: false };
    const rect = button.getBoundingClientRect();
    return { found: true, expanded: button.getAttribute('aria-expanded'), width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight, screenX, screenY, xRatio: (rect.left + rect.width / 2) / innerWidth, yRatio: (rect.top + rect.height / 2) / innerHeight };
  })()`);
  assert.equal(companionBadge.found, true, "Agent activity must render a companion status badge");
  assert.equal(companionBadge.expanded, "false");
  assert.equal(companionBadge.width >= 28 && companionBadge.height >= 20, true, "companion badge must keep a usable native hit target");
  await clickWindowPoint(petTarget, companionBadge, petWindowTitle, false);
  await waitForEvaluation(petTarget, `document.querySelectorAll('.primary-companion-item').length === 2`, 2_000);
  const companionTray = await evaluate(petTarget, `({
    expanded: document.querySelector('[data-companion-toggle]')?.getAttribute('aria-expanded'),
    rows: document.querySelectorAll('.primary-companion-item').length,
    hasHostAction: Boolean(document.querySelector('[data-companion-action]')),
    hasSafeFallback: Boolean(document.querySelector('.primary-companion-request.is-fallback')),
    fontFamily: getComputedStyle(document.querySelector('.primary-companion-tray')).fontFamily
  })`);
  assert.equal(companionTray.expanded, "true");
  assert.equal(companionTray.rows, 2);
  assert.equal(companionTray.hasHostAction, false, "observe-only providers must not receive fake host action controls");
  assert.equal(companionTray.hasSafeFallback, true, "unregistered providers must fall back to the Agent even when lifecycle events claim action support");
  assert.match(companionTray.fontFamily, /BrainPet Pixel/);
  await evaluate(petTarget, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const companionOutputPath = outputPath.replace(/(\.[^.]+)$/, "-companion$1");
  const companionScreenshot = await sendCdp(petTarget.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", fromSurface: true });
  await mkdir(dirname(companionOutputPath), { recursive: true });
  await writeFile(companionOutputPath, Buffer.from(companionScreenshot.data, "base64"));
  await clickWindowPoint(petTarget, await evaluate(petTarget, `(() => { const button = document.querySelector('[data-companion-toggle]'); const rect = button.getBoundingClientRect(); return { viewportWidth: innerWidth, viewportHeight: innerHeight, screenX, screenY, xRatio: (rect.left + rect.width / 2) / innerWidth, yRatio: (rect.top + rect.height / 2) / innerHeight }; })()`), petWindowTitle, false);
  await waitForEvaluation(petTarget, `document.querySelector('[data-companion-toggle]')?.getAttribute('aria-expanded') === 'false'`, 2_000);
  await companionClient.reportAgentActivity({ schemaVersion: 1, agent: "codex", sessionId: "smoke-working", turnId: "turn-working", state: "idle", occurredAt: companionNow + 2, capabilities: ["observeLifecycle"] });
  await companionClient.reportAgentActivity({ schemaVersion: 1, agent: "claude", sessionId: "smoke-review", turnId: "turn-cleanup", state: "idle", occurredAt: companionNow + 3, capabilities: ["observeLifecycle"] });
  await waitForEvaluation(petTarget, `!document.querySelector('[data-companion-toggle]')`, 2_000);
  await companionClient.say("PIXEL UI", { reaction: "working" });
  await waitForEvaluation(petTarget, `Boolean(document.querySelector('.bubble'))`, 2_000);
  await waitForEvaluation(petTarget, `document.fonts.status === 'loaded'`, 5_000);
  const pixelUi = await evaluate(petTarget, `(() => {
    const bubble = document.querySelector('.bubble');
    if (!(bubble instanceof HTMLElement)) return { found: false };
    const style = getComputedStyle(bubble);
    return { found: true, theme: document.documentElement.dataset.petUiTheme, fontFamily: style.fontFamily, borderRadius: style.borderRadius, borderTopWidth: style.borderTopWidth, backgroundImage: style.backgroundImage, backdropFilter: style.backdropFilter, boxShadow: style.boxShadow };
  })()`);
  assert.equal(pixelUi.found, true, "host speech must render in the pet UI");
  assert.equal(pixelUi.theme, "pixel");
  assert.match(pixelUi.fontFamily, /BrainPet Pixel/);
  assert.equal(pixelUi.borderRadius, "0px");
  assert.equal(Number.parseFloat(pixelUi.borderTopWidth) >= 2.5 && Number.parseFloat(pixelUi.borderTopWidth) <= 3.1, true, `pixel border must survive display-scale rounding; received ${pixelUi.borderTopWidth}`);
  assert.equal(pixelUi.backgroundImage, "none");
  assert.equal(pixelUi.backdropFilter, "none");
  assert.match(pixelUi.boxShadow, /4px 4px 0px/);
  const pixelUiOutputPath = outputPath.replace(/(\.[^.]+)$/, "-pet-ui$1");
  const pixelUiScreenshot = await sendCdp(petTarget.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", fromSurface: true });
  await mkdir(dirname(pixelUiOutputPath), { recursive: true });
  await writeFile(pixelUiOutputPath, Buffer.from(pixelUiScreenshot.data, "base64"));
  await evaluate(petTarget, `document.querySelector('.bubble')?.click()`);
  await waitForEvaluation(petTarget, `!document.querySelector('.bubble')`, 2_000);
  const trigger = await evaluate(petTarget, `(() => {
    const button = document.querySelector('[data-brainpet-trigger]');
    if (!(button instanceof HTMLButtonElement)) return { found: false };
    const rect = button.getBoundingClientRect();
    return { found: true, label: button.getAttribute('aria-label'), width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight, screenX, screenY, xRatio: (rect.left + rect.width / 2) / innerWidth, yRatio: (rect.top + rect.height / 2) / innerHeight };
  })()`);
  logs.push(`BrainPet trigger geometry ${JSON.stringify(trigger)}\n`);
  assert.equal(trigger.found, true, "pet training trigger must exist");
  assert.match(trigger.label, /训练|training/i);
  assert.equal(trigger.width >= 28 && trigger.height >= 28, true, "pet training trigger must remain easy to click");
  const clickedAtMs = await clickPetTrigger(petTarget, trigger);
  await waitForEvaluation(petTarget, `document.documentElement.dataset.brainpetLaunching === 'true' || document.documentElement.dataset.brainpetStageOpen === 'true'`, 500);

  let stageTarget = await waitForTarget(port, (target) => target.title === "BrainPet", 10_000);
  const expectedTaskText = forcedTask === "cargo-signal" ? "装箱，还是放过" : forcedTask === "pack-refresh" ? "行囊不重样" : forcedTask === "foundation-probe" ? "异构舞台探针" : "舞台校验器";
  const stageIdentityExpression = forcedTask === "cargo-signal"
    ? `document.readyState === 'complete' && (Boolean(document.querySelector('.tutorial-copy')) || Boolean(document.querySelector('[data-scene="cargo-toss"]')))`
    : `document.readyState === 'complete' && document.body.innerText.includes(${JSON.stringify(expectedTaskText)})`;
  const closeStageExpression = `(() => { const button = document.querySelector('[data-action="close"]'); if (button instanceof HTMLElement) button.click(); else window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })); })()`;
  await waitForEvaluation(stageTarget, stageIdentityExpression, 5_000);
  await waitForEvaluation(stageTarget, `document.fonts.status === 'loaded'`, 5_000);
  const openingMs = Date.now() - clickedAtMs;
  assert.equal(openingMs <= 500, true, `warm stage opening must stay under 500ms; received ${openingMs}ms`);
  const welcome = await evaluate(stageTarget, `(async () => {
    const loadedFaces = await document.fonts.load('12px "Fusion Pixel 12px Proportional SC"', '点击 SPACE');
    const card = document.querySelector('.stage-card');
    const prompt = document.querySelector('[data-action="skip-intro"]');
    const style = card instanceof HTMLElement ? getComputedStyle(card) : null;
    const rect = card instanceof HTMLElement ? card.getBoundingClientRect() : null;
    const promptStyle = prompt instanceof HTMLElement ? getComputedStyle(prompt) : null;
    const promptRect = prompt instanceof HTMLElement ? prompt.getBoundingClientRect() : null;
    return {
      width: innerWidth,
      height: innerHeight,
      playfieldWidth: rect?.width,
      playfieldHeight: rect?.height,
      text: document.body.innerText,
      hasSelectionButton: Boolean(document.querySelector('[data-action="start"]')),
      hasSessionPrompt: Boolean(document.querySelector('[data-action="skip-intro"]')),
      prompt: prompt instanceof HTMLElement ? { text: prompt.innerText, width: promptRect?.width, height: promptRect?.height, display: promptStyle?.display, position: promptStyle?.position, background: promptStyle?.backgroundColor, color: promptStyle?.color, borderTopWidth: promptStyle?.borderTopWidth } : null,
      cardBackground: style?.backgroundColor,
      cardBorderTopWidth: style?.borderTopWidth,
      rootBackground: getComputedStyle(document.documentElement).backgroundColor,
      fontFamily: getComputedStyle(document.documentElement).fontFamily,
      pixelFontLoaded: loadedFaces.length > 0 && loadedFaces.every((face) => face.status === 'loaded'),
      fontFaces: Array.from(document.fonts).map((face) => ({ family: face.family, status: face.status, weight: face.weight }))
    };
  })()`);
  assert.equal(welcome.playfieldWidth >= 640 && welcome.playfieldWidth <= 642, true, `playfield width must stay within DPI rounding tolerance; received ${welcome.playfieldWidth}`);
  assert.equal(welcome.playfieldHeight >= 360 && welcome.playfieldHeight <= 362, true, `playfield height must stay within DPI rounding tolerance; received ${welcome.playfieldHeight}`);
  assert.equal(welcome.width >= welcome.playfieldWidth && welcome.height >= welcome.playfieldHeight, true, "interaction overlay must contain the playfield");
  assert.equal(welcome.hasSelectionButton, false, "stage must auto-enter the selected task without a lobby button");
  if (!exerciserMode) assert.equal(welcome.hasSessionPrompt, true, "every player-opened session must wait at the operation prompt");
  assert.equal(welcome.cardBackground, "rgba(0, 0, 0, 0)", "desktop overlay must not paint a full-window card background");
  assert.equal(welcome.cardBorderTopWidth, "0px", "desktop overlay must not paint a full-window border");
  assert.equal(welcome.rootBackground, "rgba(0, 0, 0, 0)", "desktop overlay root must remain transparent");
  assert.match(welcome.fontFamily, /Fusion Pixel 12px Proportional SC/, "stage must select the embedded Fusion Pixel family");
  assert.equal(welcome.pixelFontLoaded, true, `embedded Fusion Pixel font must load for Chinese and Latin text: ${JSON.stringify(welcome.fontFaces)}`);
  const introOutputPath = outputPath.replace(/(\.[^.]+)$/, "-intro$1");
  const introScreenshot = await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", fromSurface: true });
  await mkdir(dirname(introOutputPath), { recursive: true });
  await writeFile(introOutputPath, Buffer.from(introScreenshot.data, "base64"));
  const promptDismissedAt = Date.now();
  await evaluate(stageTarget, `document.querySelector('[data-action="skip-intro"]')?.click()`);
  if (!exerciserMode) {
    await delay(300);
    assert.equal(await evaluate(stageTarget, `Boolean(document.querySelector('.task-card'))`), false, "operation prompt must leave a visible preparation buffer before the first trial");
  }
  await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.task-card'))`, 5_000);
  const introBufferMs = exerciserMode ? 0 : Date.now() - promptDismissedAt;
  if (!exerciserMode) assert.equal(introBufferMs >= 550 && introBufferMs <= 1_500, true, `preparation buffer must stay perceptible and bounded; received ${introBufferMs}ms`);
  const videoRecording = videoPath ? recordStageVideo(stageTarget, videoPath, 6_000) : null;
  let foundationInputVerified = false;
  let nativeReactionClickVerified = false;
  let petThrowVerified = false;
  if (forcedTask === "foundation-probe") {
    await evaluate(stageTarget, `document.querySelector('[data-scene-input="primary"]')?.click()`);
    await waitForEvaluation(stageTarget, `document.body.innerText.includes('0010')`, 2_000);
    await evaluate(stageTarget, `document.querySelector('[data-scene-input="secondary"]')?.click()`);
    await waitForEvaluation(stageTarget, `document.body.innerText.includes('0020')`, 2_000);
    foundationInputVerified = true;
  }
  if (forcedTask === "cargo-signal") {
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.rig-projectile'))`, 2_000);
    const cargoScene = await evaluate(stageTarget, `(() => ({
      scene: document.querySelector('[data-scene="cargo-toss"]')?.getAttribute('data-scene'),
      dock: Boolean(document.querySelector('[data-asset="cargo-dock"]')),
      target: Boolean(document.querySelector('.rig-projectile'))
    }))()`);
    assert.equal(cargoScene.scene, "cargo-toss", "cargo signal must use the generic scene runtime");
    assert.equal(cargoScene.dock, true, "cargo signal must render its landing dock");
    assert.equal(cargoScene.target, true, "cargo signal must render a pet-originated flying object");
    await evaluate(stageTarget, `(() => {
      window.__brainPetNativeReactionPointerUps = 0;
      document.addEventListener('pointerup', (event) => { if (event.target instanceof Element && event.target.closest('.stage-input-surface')) window.__brainPetNativeReactionPointerUps += 1; });
    })()`);
    const reactionTarget = await evaluate(stageTarget, `(() => {
      const target = document.querySelector('.stage-input-surface');
      if (!(target instanceof HTMLElement)) return { found: false };
      const rect = target.getBoundingClientRect();
      return { found: true, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight, screenX, screenY, xRatio: (rect.left + rect.width / 2) / innerWidth, yRatio: (rect.top + rect.height / 2) / innerHeight };
    })()`);
    assert.equal(reactionTarget.found, true, "cargo signal must expose the full-stage input surface");
    assert.equal(reactionTarget.width >= 639 && reactionTarget.height >= 359, true, `input surface must cover the full game stage: ${JSON.stringify(reactionTarget)}`);
    await clickWindowPoint(stageTarget, reactionTarget, "BrainPet", true);
    await waitForEvaluation(stageTarget, `window.__brainPetNativeReactionPointerUps === 1`, 2_000);
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.score-pop'))`, 1_000);
    nativeReactionClickVerified = true;
    assert.equal(await evaluate(stageTarget, `Boolean(document.querySelector('.focus-stage')) && !document.querySelector('.task-copy') && !document.querySelector('.hud') && !document.querySelector('.focus-hud') && !document.querySelector('.focus-chrome') && !document.querySelector('.task-card footer')`), true, "cargo signal must keep peripheral task chrome out of the reaction stage");
  }

  const stagePositionBefore = await evaluate(stageTarget, `(() => { const rect = document.querySelector('.stage-card')?.getBoundingClientRect(); return { x: screenX + (rect?.left ?? 0), y: screenY + (rect?.top ?? 0) }; })()`);
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
  const stagePositionAfter = await evaluate(stageTarget, `(() => { const rect = document.querySelector('.stage-card')?.getBoundingClientRect(); return { x: screenX + (rect?.left ?? 0), y: screenY + (rect?.top ?? 0) }; })()`);
  const petIndependentMove = Math.abs(stagePositionAfter.x - stagePositionBefore.x) <= 2 && Math.abs(stagePositionAfter.y - stagePositionBefore.y) <= 2;
  assert.equal(petIndependentMove, true, "moving the pet must leave the user-positioned game area in place");

  const independentBefore = {
    stage: await evaluate(stageTarget, `(() => { const rect = document.querySelector('.stage-card')?.getBoundingClientRect(); return { x: screenX + (rect?.left ?? 0), y: screenY + (rect?.top ?? 0) }; })()`),
    pet: await evaluate(petTarget, `({ x: screenX, y: screenY })`),
  };
  const stageDrag = await evaluate(stageTarget, `(() => {
    const surface = document.querySelector('[data-rig-drag-surface]');
    if (!(surface instanceof HTMLElement)) return { moved: false };
    const rect = surface.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const startX = screenX + clientX;
    const startY = screenY + clientY;
    surface.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, pointerId: 91, clientX, clientY, screenX: startX, screenY: startY }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, buttons: 1, pointerId: 91, clientX: clientX + 90, clientY, screenX: startX + 90, screenY: startY }));
    return { moved: true };
  })()`);
  assert.equal(stageDrag.moved, true, "stage rig drag surface must exist");
  if (forcedTask === "cargo-signal") await waitForEvaluation(stageTarget, `!document.querySelector('.rig-projectile')`, 5_000);
  const trialVisualHiddenDuringDrag = true;
  await evaluate(stageTarget, `document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, buttons: 0, pointerId: 91 }))`);
  if (forcedTask === "cargo-signal") {
    await waitForEvaluation(petTarget, `document.documentElement.dataset.brainpetThrow === 'left' || document.documentElement.dataset.brainpetThrow === 'right'`, 1_000);
    petThrowVerified = true;
  }
  await delay(forcedTask === "cargo-signal" ? 100 : 500);
  let restartedTrialProgress = null;
  if (forcedTask === "cargo-signal") {
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.rig-projectile')) && Boolean(document.querySelector('[data-scene-input="primary"]'))`, 5_000);
    restartedTrialProgress = Number(await evaluate(stageTarget, `document.querySelector('[data-rig-progress]')?.getAttribute('data-rig-progress')`));
    assert.equal(restartedTrialProgress <= 0.45, true, `restarted trial must reappear near its origin; received progress ${restartedTrialProgress}`);
  }
  const independentAfter = {
    stage: await evaluate(stageTarget, `(() => { const rect = document.querySelector('.stage-card')?.getBoundingClientRect(); return { x: screenX + (rect?.left ?? 0), y: screenY + (rect?.top ?? 0) }; })()`),
    pet: await evaluate(petTarget, `({ x: screenX, y: screenY })`),
  };
  const stageDelta = { x: independentAfter.stage.x - independentBefore.stage.x, y: independentAfter.stage.y - independentBefore.stage.y };
  const petDelta = { x: independentAfter.pet.x - independentBefore.pet.x, y: independentAfter.pet.y - independentBefore.pet.y };
  const rigIndependentDrag = (Math.abs(stageDelta.x) + Math.abs(stageDelta.y) > 0) && Math.abs(petDelta.x) <= 2 && Math.abs(petDelta.y) <= 2;
  assert.equal(rigIndependentDrag, true, `dragging the game area must leave the pet in place: ${JSON.stringify({ stageDelta, petDelta })}`);
  await waitForEvaluation(stageTarget, `!document.querySelector('.focus-pause') && !document.body.innerText.includes('PAUSED')`, 5_000);
  const rigAutoResume = true;

  let focusPause = false;
  if (!verifyCompletion && !skipFocusPause) {
    await sendCdp(petTarget.webSocketDebuggerUrl, "Page.bringToFront", {});
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.focus-pause')) || document.body.innerText.includes('PAUSED')`, 5_000);
    await delay(250);
    await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.bringToFront", {});
    await waitForEvaluation(stageTarget, `!document.querySelector('.focus-pause') && !document.body.innerText.includes('PAUSED')`, 5_000);
    focusPause = true;
  }

  const screenshot = await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", fromSurface: true });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  if (videoRecording) await videoRecording;

  let completion = null;
  let resultOutputPath = null;
  let petToggleCloseVerified = false;
  if (verifyCompletion) {
    assert.equal(forcedTask, "cargo-signal", "completion smoke currently requires the deterministic cargo-signal task");
    // Visual capture and anchor movement can suspend rAF in Chromium. Start a clean
    // measured session so the quality gate reflects play rather than CDP tooling.
    await evaluate(petTarget, `document.querySelector('[data-brainpet-trigger]')?.click()`);
    await waitForTargetToDisappear(port, stageTarget.id, 10_000);
    const previousPetTargetId = petTarget.id;
    petTarget = await waitForTarget(port, (target) => target.title === petWindowTitle && target.id !== previousPetTargetId, 5_000);
    await waitForEvaluation(petTarget, `document.documentElement.dataset.brainpetStageOpen !== 'true'`, 2_000);
    petToggleCloseVerified = true;
    await evaluate(petTarget, `document.querySelector('[data-brainpet-trigger]')?.click()`);
    stageTarget = await waitForTarget(port, (target) => target.title === "BrainPet", 10_000);
    await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.bringToFront", {});
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('[data-action="skip-intro"]'))`, 5_000);
    await evaluate(stageTarget, `document.querySelector('[data-action="skip-intro"]')?.click()`);
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.task-card'))`, 5_000);
    await evaluate(stageTarget, `(() => {
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (handler, timeout, ...args) => nativeSetTimeout(handler, timeout === 4000 ? 60000 : timeout, ...args);
      window.__brainPetAutoInput = window.setInterval(() => { const target = document.querySelector('[data-rig-projectile-input="primary"], .tone-sky [data-scene-input="primary"], .tone-sky [data-action="primary"]'); if (target instanceof HTMLElement) target.click(); }, 60);
    })()`);
    // Avoid opening a fresh CDP socket 20 times per second during the measured
    // session; that instrumentation itself creates artificial 300-500 ms gaps.
    await delay(30_000);
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.result-card'))`, 12_000);
    await evaluate(stageTarget, `window.clearInterval(window.__brainPetAutoInput)`);
    await waitForEvaluation(stageTarget, `!document.body.innerText.includes('CHECKING...')`, 5_000);
    completion = await evaluate(stageTarget, `({ text: document.body.innerText, hasRetry: Boolean(document.querySelector('[data-action="again"]')), minimal: Boolean(document.querySelector('.minimal-result')) })`);
    await delay(250);
    const persisted = JSON.parse(await readFile(join(userDataDir, "brainpet-state.json"), "utf8"));
    completion.quality = persisted.recentResults?.[0]?.quality ?? null;
    assert.equal(completion.minimal || /今日已完成 1 关/.test(completion.text), true, "result must render either the minimal report or the full exerciser receipt");
    assert.equal(completion.quality?.valid, true, `completion quality must be valid: ${JSON.stringify(completion.quality)}`);
    assert.equal(completion.minimal || /QUEST CLEAR!/.test(completion.text), true, "result must render either the minimal report or the full clear state");
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
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.task-card.focus-stage')) || (Boolean(document.querySelector('.task-card')) && document.body.innerText.includes('第 1 关'))`, 5_000);
    if (!skipFocusPause) {
      await sendCdp(petTarget.webSocketDebuggerUrl, "Page.bringToFront", {});
      await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.focus-pause')) || document.body.innerText.includes('PAUSED')`, 5_000);
      await delay(250);
      await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.bringToFront", {});
      await waitForEvaluation(stageTarget, `!document.querySelector('.focus-pause') && !document.body.innerText.includes('PAUSED')`, 5_000);
      focusPause = true;
    }
  }

  for (let cycle = 1; cycle < lifecycleCycles; cycle += 1) {
    await evaluate(stageTarget, closeStageExpression);
    await waitForTargetToDisappear(port, stageTarget.id, 10_000);
    const currentPetTarget = await waitForTarget(port, (target) => target.title === petWindowTitle, 5_000);
    await evaluate(currentPetTarget, `document.querySelector('[data-brainpet-trigger]')?.click()`);
    stageTarget = await waitForTarget(port, (target) => target.title === "BrainPet", 10_000);
    await waitForEvaluation(stageTarget, stageIdentityExpression, 5_000);
    await evaluate(stageTarget, `document.querySelector('[data-action="skip-intro"]')?.click()`);
    await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.task-card'))`, 5_000);
  }

  const soak = await runSoak(stageTarget, soakMs);
  if (soakMs >= 60_000) assert.equal(soak.heapGrowthBytes <= 32 * 1024 * 1024, true, `renderer heap grew by ${soak.heapGrowthBytes} bytes during soak`);
  const activeProcessMetrics = process.platform === "win32" ? await measureProcessesForUserDataDir(userDataDir) : null;
  if (enforceResourceBudget && activeProcessMetrics) {
    assertProcessBudget("active", activeProcessMetrics, { processCount: (idleProcessMetrics?.processCount ?? 4) + 2, workingSetBytes: 650 * 1024 * 1024, privateBytes: 650 * 1024 * 1024 });
  }
  assert.doesNotMatch(logs.join(""), /invalid stage event rejected|stage event transition rejected/, "host must accept every validated session event during smoke and soak");

  let togglePetTarget = await waitForTarget(port, (target) => target.title === petWindowTitle, 5_000);
  await evaluate(togglePetTarget, `document.querySelector('[data-brainpet-trigger]')?.click()`);
  await waitForTargetToDisappear(port, stageTarget.id, 10_000);
  const closedPetTargetId = togglePetTarget.id;
  togglePetTarget = await waitForTarget(port, (target) => target.title === petWindowTitle && target.id !== closedPetTargetId, 5_000);
  await waitForEvaluation(togglePetTarget, `document.documentElement.dataset.brainpetStageOpen !== 'true'`, 2_000);
  const postTrainingIdle = await evaluate(togglePetTarget, `(() => {
    const sprite = document.querySelector('.sprite');
    if (!(sprite instanceof HTMLElement)) return null;
    const style = getComputedStyle(sprite);
    return { backgroundImage: style.backgroundImage, animationName: style.animationName };
  })()`);
  assert.match(postTrainingIdle?.backgroundImage ?? "", /default-pet-thumbnail\.png/, "normal stage close must release the full spritesheet in the replacement pet renderer");
  assert.equal(postTrainingIdle?.animationName, "none", "post-training static idle must disable sprite animation");
  petToggleCloseVerified = true;
  await delay(15_000);
  const hotIdleProcessMetrics = process.platform === "win32"
    ? await waitForProcessCount(userDataDir, (idleProcessMetrics?.processCount ?? 5) + 1, 5_000)
    : null;
  if (hotIdleProcessMetrics) process.stdout.write(`BRAINPET_RESOURCE_METRICS ${JSON.stringify({ phase: "hot-idle", metrics: hotIdleProcessMetrics })}\n`);
  if (enforceResourceBudget && hotIdleProcessMetrics) {
    assertProcessBudget("warmed idle", hotIdleProcessMetrics, { processCount: (idleProcessMetrics?.processCount ?? 5) + 1, workingSetBytes: 500 * 1024 * 1024, privateBytes: 500 * 1024 * 1024 });
    if (idleProcessMetrics) {
      const hotIdleGrowthBytes = hotIdleProcessMetrics.workingSetBytes - idleProcessMetrics.workingSetBytes;
      assert.equal(hotIdleGrowthBytes <= 100 * 1024 * 1024, true, `normal stage close retained ${formatMiB(hotIdleGrowthBytes)} above cold idle: cold=${JSON.stringify(idleProcessMetrics.processes)} hot=${JSON.stringify(hotIdleProcessMetrics.processes)}`);
    }
  }
  await evaluate(togglePetTarget, `document.querySelector('[data-brainpet-trigger]')?.click()`);
  stageTarget = await waitForTarget(port, (target) => target.title === "BrainPet", 10_000);
  await waitForEvaluation(stageTarget, stageIdentityExpression, 5_000);
  await waitForEvaluation(togglePetTarget, `(() => {
    const sprite = document.querySelector('.sprite');
    if (!(sprite instanceof HTMLElement)) return false;
    const style = getComputedStyle(sprite);
    return /default-pet-spritesheet\\.webp/.test(style.backgroundImage) && style.animationName !== 'none';
  })()`, 5_000);
  await evaluate(stageTarget, `document.querySelector('[data-action="skip-intro"]')?.click()`);
  await waitForEvaluation(stageTarget, `Boolean(document.querySelector('.task-card'))`, 5_000);

  try {
    await sendCdp(stageTarget.webSocketDebuggerUrl, "Page.crash", {});
  } catch {
    // Chromium closes the target socket as part of the intentional crash.
  }
  await delay(500);
  const remainingTargets = await listTargets(port);
  assert.equal(remainingTargets.some((target) => target.title === petWindowTitle), true, "stage crash must not close the pet host");
  const currentPetTarget = await waitForTarget(port, (target) => target.title === petWindowTitle, 5_000);
  await evaluate(currentPetTarget, `document.querySelector('[data-brainpet-trigger]')?.click()`);
  const recoveredStageTarget = await waitForTarget(port, (target) => target.title === "BrainPet" && target.id !== stageTarget.id, 10_000);
  assert.notEqual(recoveredStageTarget.id, stageTarget.id, "crash recovery must create a fresh renderer target");
  await waitForEvaluation(recoveredStageTarget, stageIdentityExpression, 5_000);
  await evaluate(recoveredStageTarget, `document.querySelector('[data-action="skip-intro"]')?.click()`);
  await waitForEvaluation(recoveredStageTarget, `Boolean(document.querySelector('.task-card'))`, 5_000);
  await evaluate(recoveredStageTarget, closeStageExpression);
  await waitForTargetToDisappear(port, recoveredStageTarget.id, 10_000);
  await delay(2_000);
  const recoveredIdleProcessMetrics = process.platform === "win32"
    ? await waitForProcessCount(userDataDir, (idleProcessMetrics?.processCount ?? 5) + 1, 5_000)
    : null;
  if (enforceResourceBudget && recoveredIdleProcessMetrics) {
    assert.equal(recoveredIdleProcessMetrics.processCount <= (idleProcessMetrics?.processCount ?? 5) + 1, true, `crash recovery left too many processes: ${JSON.stringify(recoveredIdleProcessMetrics.processes)}`);
  }
  assert.doesNotMatch(logs.join(""), /invalid stage event rejected|stage event transition rejected/, "crash recovery must leave the Host lifecycle valid");

  process.stdout.write(`${JSON.stringify({ ok: true, outputPath, introOutputPath, companionOutputPath, pixelUiOutputPath, resultOutputPath, videoPath, petReadyMs, idleProcessMetrics, activeProcessMetrics, hotIdleProcessMetrics, recoveredIdleProcessMetrics, companionVerified: true, pixelUiVerified: true, trigger, stage: { width: welcome.width, height: welcome.height, desktopOverlay: true }, prompt: welcome.prompt, introBufferMs, openingMs, petIndependentMove, rigIndependentDrag, trialVisualHiddenDuringDrag, restartedTrialProgress, rigAutoResume, focusPause, nativeReactionClickVerified, petThrowVerified, petToggleCloseVerified, completionVerified: Boolean(completion), completionQuality: completion?.quality ?? null, foundationInputVerified, lifecycleCycles, soak, crashIsolated: true, crashRecovered: true })}\n`);
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
  return clickWindowPoint(petTarget, trigger, petWindowTitle, false);
}

async function clickWindowPoint(target, geometry, windowTitle, useOsClick) {
  if (process.platform !== "win32") {
    const x = geometry.xRatio * geometry.viewportWidth;
    const y = geometry.yRatio * geometry.viewportHeight;
    await sendCdp(target.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sendCdp(target.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sendCdp(target.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
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
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
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
  public static void ClickAtCursor() {
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
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
if ($env:BRAINPET_NATIVE_OS_CLICK -eq '1') { [BrainPetNativePointer]::ClickAtCursor() }
elseif (-not [BrainPetNativePointer]::PostLeftClick($handle, $clientX, $clientY)) { throw 'BrainPet native window click message failed.' }
Write-Output ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
`;
  const output = await runPowerShell(script, {
    BRAINPET_NATIVE_WINDOW_TITLE: windowTitle,
    BRAINPET_NATIVE_USER_DATA: userDataDir,
    BRAINPET_NATIVE_SCREEN_X: String(geometry.screenX),
    BRAINPET_NATIVE_SCREEN_Y: String(geometry.screenY),
    BRAINPET_NATIVE_VIEWPORT_WIDTH: String(geometry.viewportWidth),
    BRAINPET_NATIVE_VIEWPORT_HEIGHT: String(geometry.viewportHeight),
    BRAINPET_NATIVE_X_RATIO: String(geometry.xRatio),
    BRAINPET_NATIVE_Y_RATIO: String(geometry.yRatio),
    BRAINPET_NATIVE_OS_CLICK: useOsClick ? "1" : "0",
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
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
$roots = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
if ($roots.Count -eq 0) { exit 0 }
$rootNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($root in $roots) { [void]$rootNames.Add([string]$root.Name) }
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
foreach ($root in $roots) { [void]$ids.Add([uint32]$root.ProcessId) }
do {
  $changed = $false
  foreach ($process in $all) {
    if ($rootNames.Contains([string]$process.Name) -and $ids.Contains([uint32]$process.ParentProcessId) -and $ids.Add([uint32]$process.ProcessId)) { $changed = $true }
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
$rootNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($root in $roots) { [void]$rootNames.Add([string]$root.Name) }
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
foreach ($root in $roots) { [void]$ids.Add([uint32]$root.ProcessId) }
do {
  $changed = $false
  foreach ($process in $all) {
    if ($rootNames.Contains([string]$process.Name) -and $ids.Contains([uint32]$process.ParentProcessId) -and $ids.Add([uint32]$process.ProcessId)) { $changed = $true }
  }
} while ($changed)
$selected = @($all | Where-Object { $ids.Contains([uint32]$_.ProcessId) })
$workingSet = ($selected | Measure-Object WorkingSetSize -Sum).Sum
$privateBytes = ($selected | Measure-Object PrivatePageCount -Sum).Sum
$processes = @($selected | ForEach-Object {
  $role = if ($_.CommandLine -match '--type=([^\s"]+)') { $Matches[1] } else { 'browser' }
  [pscustomobject]@{ pid = [uint32]$_.ProcessId; parentPid = [uint32]$_.ParentProcessId; role = $role; workingSetBytes = [int64]$_.WorkingSetSize; privateBytes = [int64]$_.PrivatePageCount }
})
[pscustomobject]@{
  processCount = $selected.Count
  workingSetBytes = [int64]$workingSet
  privateBytes = [int64]$privateBytes
  names = @($selected | Group-Object Name | ForEach-Object { $_.Name + ':' + $_.Count })
  processes = $processes
} | ConvertTo-Json -Compress
`;
  const output = await runPowerShell(script, { BRAINPET_METRICS_USER_DATA: directory });
  return JSON.parse(output.trim());
}

async function waitForProcessCount(directory, maximum, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let metrics = await measureProcessesForUserDataDir(directory);
  while (metrics.processCount > maximum && Date.now() < deadline) {
    await delay(250);
    metrics = await measureProcessesForUserDataDir(directory);
  }
  return metrics;
}

function assertProcessBudget(label, metrics, budget) {
  assert.equal(metrics.processCount <= budget.processCount, true, `${label} process count ${metrics.processCount} exceeds ${budget.processCount}: ${metrics.names.join(", ")} ${JSON.stringify(metrics.processes)}`);
  const details = `${metrics.names.join(", ")} ${JSON.stringify(metrics.processes)}`;
  assert.equal(metrics.workingSetBytes <= budget.workingSetBytes, true, `${label} working set ${formatMiB(metrics.workingSetBytes)} exceeds ${formatMiB(budget.workingSetBytes)}: ${details}`);
  assert.equal(metrics.privateBytes <= budget.privateBytes, true, `${label} private bytes ${formatMiB(metrics.privateBytes)} exceeds ${formatMiB(budget.privateBytes)}: ${details}`);
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
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
