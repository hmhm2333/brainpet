import type { BrainPetTaskId, BrainPetTaskResult, BrainPetTaskSessionConfig } from "../../../brainpet/task-contract";
import { getBrainPetDifficultyParameters, getBrainPetTaskManifest, listPlayableBrainPetTaskIds } from "../../../brainpet/task-registry";
import { hasBrainPetRigDragStarted, type BrainPetRigPointer } from "../../../brainpet/rig-drag-gesture";
import { createTaskModule, type BrainPetTaskModule } from "./task-modules";
import { LogicalSessionClock, StageQualityMonitor, loadStageSettings, saveStageSettings, type BrainPetStageSettings } from "./stage-runtime";
import { StageAssetRegistry, type StageAssetStatus, type StageScene } from "./stage-services";
import defaultPetSpritesheetUrl from "../../../../assets/default-pet-spritesheet.webp";
import "./stage.css";

const root = requireRoot();

let activeTask: BrainPetTaskModule | null = null;
let animationFrame = 0;
let seed = 1;
let bootstrap: Awaited<ReturnType<typeof window.brainPet.getBootstrap>>;
let lastRenderedAt = 0;
let lastFeedback = "neutral";
let taskRenderKey = "";
let audioContext: AudioContext | null = null;
let resultCloseTimer = 0;
let introTimer = 0;
let introStarting = false;
let agentCompletionPending = false;
let stagePhase: "intro" | "running" | "result" = "intro";
let currentSession: BrainPetTaskSessionConfig;
let lastFinishedResult: BrainPetTaskResult | null = null;
let sessionOutcome: Extract<Parameters<Parameters<Window["brainPet"]["onHostEvent"]>[0]>[0], { readonly type: "session-outcome" }> | null = null;
let settings: BrainPetStageSettings = loadStageSettings(localStorage);
let quality = new StageQualityMonitor();
let eventLog: Array<{ readonly type: string; readonly atMs: number; readonly details?: unknown }> = [];
const clock = new LogicalSessionClock();
type PauseReason = "manual" | "focus" | "visibility" | "host" | "rig-drag";
const pauseReasons = new Set<PauseReason>();
const stageAssets = new StageAssetRegistry();
let loadedAssets = new Map<string, StageAssetStatus>();
let taskStartGeneration = 0;
let pointerInteractive: boolean | null = null;
let rigPointer: { readonly pointerId: number; readonly start: BrainPetRigPointer; readonly input: "primary" | "secondary" | null; dragging: boolean } | null = null;
let suppressRigClickUntil = 0;
let lastAnimatedProjectileId = "";
const bridge = getBridge();

const INTERACTIVE_SELECTOR = "button, input, [data-action], [data-scene-input], [data-rig-projectile-input], [data-rig-drag-surface], .stimulus, [data-primary-surface='true'], .welcome-copy";

void initialize();

async function initialize(): Promise<void> {
  bootstrap = await bridge.getBootstrap();
  applyRigGeometry(bootstrap.rig);
  currentSession = bootstrap.session;
  seed = currentSession.seed;
  renderIntro(currentSession);
  bridge.ready();
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("blur", () => setPauseReason("focus", true));
  window.addEventListener("focus", () => setPauseReason("focus", false));
  document.addEventListener("visibilitychange", () => setPauseReason("visibility", document.hidden));
  document.addEventListener("mousemove", updatePointerInteractivity, { passive: true });
  document.addEventListener("mouseleave", () => setPointerInteractive(false));
  document.addEventListener("focusin", () => setPointerInteractive(true));
  document.addEventListener("focusout", () => setPointerInteractive(false));
  document.addEventListener("pointerdown", handleRigPointerDown, true);
  document.addEventListener("pointermove", handleRigPointerMove, true);
  document.addEventListener("pointerup", handleRigPointerEnd, true);
  document.addEventListener("pointercancel", handleRigPointerEnd, true);
  document.addEventListener("click", suppressClickAfterRigDrag, true);
  bridge.onHostEvent(handleHostEvent);
  applySettings();
  setPointerInteractive(false);
  if (bootstrap.mode === "stage-exerciser") {
    introTimer = window.setTimeout(() => { void startTask(currentSession); }, 120);
  }
}

function renderIntro(session: BrainPetTaskSessionConfig): void {
  introStarting = false;
  const manifest = getBrainPetTaskManifest(session.taskId);
  const manifestTitle = manifest.title;
  const rule = manifest.introRule;
  const focusMode = bootstrap.mode !== "stage-exerciser";
  root.innerHTML = `<section class="stage-card welcome-card intro-card${focusMode ? " focus-intro" : ""}">
    ${focusMode ? "" : chrome(manifestTitle, `LEVEL ${session.level}`)}
    <div class="sky-layer" aria-hidden="true"><i></i><i></i><i></i></div>
    ${focusMode ? `<div class="welcome-copy tutorial-copy reaction-panel" data-action="skip-intro" role="button" tabindex="0" aria-label="${escapeHtml(rule)}"><span class="tutorial-blue"><i></i>点击 / SPACE 开始</span><span class="tutorial-red"><i></i>不要按</span></div>` : `<div class="welcome-copy" data-rig-drag-surface="true"><h1>${escapeHtml(manifestTitle)}</h1><p>${escapeHtml(rule)}</p><div class="intro-countdown" aria-label="即将开始"><i></i><i></i><i></i></div></div>`}
    ${focusMode ? "" : `<div class="platform" aria-hidden="true"><span class="pet-scout">${petSprite("idle")}</span><i></i><i></i><i></i></div>`}
  </section>`;
  bindChrome();
  root.querySelector(".welcome-copy")?.addEventListener("click", skipIntro);
}

function skipIntro(): void {
  if (stagePhase !== "intro" || introStarting) return;
  introStarting = true;
  window.clearTimeout(introTimer);
  renderReadyBuffer();
  introTimer = window.setTimeout(() => { void startTask(currentSession); }, 650);
}

function renderReadyBuffer(): void {
  root.innerHTML = `<section class="stage-card intro-card focus-intro"><div class="focus-ready" aria-label="准备开始"><i></i><i></i><i></i></div></section>`;
  setPointerInteractive(false);
}

async function startTask(session: BrainPetTaskSessionConfig): Promise<void> {
  if (stagePhase === "running") return;
  const generation = ++taskStartGeneration;
  window.clearTimeout(resultCloseTimer);
  window.clearTimeout(introTimer);
  introStarting = false;
  cancelAnimationFrame(animationFrame);
  currentSession = session;
  seed = session.seed;
  const manifest = getBrainPetTaskManifest(session.taskId);
  const assets = await stageAssets.preload(manifest.assets ?? [], loadStageAsset);
  if (generation !== taskStartGeneration) return;
  loadedAssets = new Map(assets.map((asset) => [asset.id, asset]));
  activeTask = createTaskModule(session.taskId);
  const now = performance.now();
  activeTask.start(seed, session.level, now, session.parameters);
  bridge.report({ type: "session-started", session });
  stagePhase = "running";
  lastFinishedResult = null;
  sessionOutcome = null;
  agentCompletionPending = false;
  const startPausedForRig = pauseReasons.has("rig-drag") || bootstrap.rig.dragging;
  pauseReasons.clear();
  if (startPausedForRig) pauseReasons.add("rig-drag");
  clock.reset();
  if (startPausedForRig) {
    clock.pause(now);
    bridge.report({ type: "pause-requested" });
  }
  quality = new StageQualityMonitor();
  eventLog = [];
  logStageEvent("session-started", { taskId: session.taskId, seed, level: session.level });
  lastRenderedAt = 0;
  lastFeedback = "neutral";
  taskRenderKey = "";
  playSound("start");
  renderTask();
  animationFrame = requestAnimationFrame(tick);
}

function tick(now: number): void {
  if (!activeTask) return;
  if (!clock.paused) quality.frame(now);
  const taskNow = logicalNow(now);
  if (!clock.paused) activeTask.tick(taskNow);
  if (now - lastRenderedAt >= 80 || activeTask.finished) {
    renderTask();
    lastRenderedAt = now;
  }
  if (activeTask.finished) {
    finishTask(taskNow);
    return;
  }
  animationFrame = requestAnimationFrame(tick);
}

function renderTask(): void {
  const task = activeTask;
  if (!task) return;
  const frame = task.frame;
  const paused = clock.paused;
  const rigDragging = pauseReasons.has("rig-drag");
  const focusMode = Boolean(frame.scene) && bootstrap.mode !== "stage-exerciser";
  const renderKey = JSON.stringify({
    taskId: task.manifest.id,
    paused,
    rigDragging,
    eyebrow: frame.eyebrow,
    title: frame.title,
    instruction: frame.instruction,
    symbol: frame.symbol,
    tone: frame.tone,
    slots: frame.slots,
    choices: frame.choices,
    feedback: frame.feedback,
    feedbackText: frame.feedbackText,
    feedbackScore: frame.feedbackScore,
    primarySurface: frame.primarySurface,
    combo: frame.combo,
    scene: frame.scene,
  });
  if (renderKey === taskRenderKey && root.querySelector(".task-card")) {
    const score = root.querySelector<HTMLElement>("[data-live='score']");
    const progress = root.querySelector<SVGRectElement>("[data-live='progress']");
    const progressTrack = root.querySelector<SVGElement>(".progress-track");
    if (score) score.textContent = frame.score.toString().padStart(4, "0");
    if (progress) progress.setAttribute("width", String(Math.round(frame.progress * 100)));
    progressTrack?.setAttribute("aria-label", `进度 ${Math.round(frame.progress * 100)}%`);
    return;
  }
  taskRenderKey = renderKey;
  root.innerHTML = `<section class="stage-card task-card tone-${frame.tone} feedback-${frame.feedback ?? "neutral"}${focusMode ? " focus-stage" : ""}">
    ${focusMode ? "" : chrome(task.manifest.title, paused ? "PAUSED" : "TRAINING")}
    ${focusMode ? "" : `<div class="hud"><span>${escapeHtml(frame.eyebrow)}</span>${(frame.combo ?? 0) >= 3 ? `<em>COMBO ×${frame.combo}</em>` : ""}<strong data-live="score">${frame.score.toString().padStart(4, "0")}</strong></div>`}
    ${focusMode ? "" : `<svg class="progress-track" viewBox="0 0 100 1" preserveAspectRatio="none" aria-label="进度 ${Math.round(frame.progress * 100)}%"><rect data-live="progress" x="0" y="0" width="${Math.round(frame.progress * 100)}" height="1"></rect></svg>`}
    <div class="task-layout" data-rig-drag-surface="true"${frame.primarySurface ? ` data-primary-surface="true"` : ""}>
      ${focusMode ? "" : `<div class="task-copy"><h1>${escapeHtml(frame.title)}</h1><p>${escapeHtml(frame.instruction)}</p></div>`}
      ${frame.scene ? renderStageScene(frame.scene) : `<div class="stimulus" data-action="primary"><span>${escapeHtml(frame.symbol)}</span></div>
      ${frame.slots ? `<div class="memory-slots">${frame.slots.map((slot) => `<i>${escapeHtml(slot)}</i>`).join("")}</div>` : ""}
      ${frame.choices ? `<div class="choice-row">${frame.choices.map((choice, index) => `<button data-choice="${index}"><kbd>${index === 0 ? "←" : "→"}</kbd>${escapeHtml(choice)}</button>`).join("")}</div>` : ""}`}
      ${focusMode && paused ? `<div class="focus-pause" role="status" aria-label="已暂停"><i></i><i></i><i></i></div>` : ""}
      ${frame.feedbackText ? (focusMode ? `<div class="score-pop score-pop-${frame.feedback}">${typeof frame.feedbackScore === "number" && frame.feedbackScore > 0 ? "+" : ""}${frame.feedbackScore ?? ""}</div>` : `<div class="feedback-toast">${escapeHtml(frame.feedbackText)}</div>`) : ""}
      ${bootstrap.mode === "stage-exerciser" ? `<aside class="dev-tools"><label>SEED <input data-dev="seed" inputmode="numeric" value="${seed}"></label><button data-dev="replay">固定 seed 重放</button><button data-dev="export">导出事件</button></aside>` : ""}
    </div>
    ${focusMode && frame.scene?.reactionInput ? `<button class="stage-input-surface" data-scene-input="${frame.scene.reactionInput}" data-rig-drag-surface="true" aria-label="游戏区：单击反应，按住移动可拖动"></button>` : ""}
    ${frame.scene && !rigDragging ? renderRigProjectiles(frame.scene) : ""}
    ${bootstrap.mode === "stage-exerciser" ? `<footer><span>${qualityLabel()}</span><button data-action="pause">${paused ? "继续" : "暂停"}</button></footer>` : ""}
  </section>`;
  bindChrome();
  if (frame.primarySurface === undefined) root.querySelector("[data-action='primary']")?.addEventListener("click", () => sendInput("primary"));
  if (frame.primarySurface) root.querySelector(".task-layout")?.addEventListener("click", (event) => { if (!(event.target as Element).closest("button")) sendInput("primary"); });
  root.querySelector("[data-choice='0']")?.addEventListener("click", () => sendInput("primary"));
  root.querySelector("[data-choice='1']")?.addEventListener("click", () => sendInput("secondary"));
  for (const target of root.querySelectorAll<HTMLElement>("[data-scene-input]")) target.addEventListener("click", () => sendInput(target.dataset.sceneInput === "secondary" ? "secondary" : "primary"));
  for (const target of root.querySelectorAll<HTMLElement>("[data-rig-projectile-input]")) target.addEventListener("click", () => sendInput(target.dataset.rigProjectileInput === "secondary" ? "secondary" : "primary"));
  animatePetThrowForScene(frame.scene);
  root.querySelector("[data-action='pause']")?.addEventListener("click", togglePause);
  root.querySelector("[data-dev='replay']")?.addEventListener("click", replayFixedSeed);
  root.querySelector("[data-dev='export']")?.addEventListener("click", exportEventLog);
  if (frame.feedback && frame.feedback !== "neutral" && frame.feedback !== lastFeedback) playSound(frame.feedback === "correct" ? "correct" : "incorrect");
  lastFeedback = frame.feedback ?? "neutral";
}

function finishTask(now: number): void {
  const task = activeTask;
  if (!task) return;
  const baseResult = task.result(now);
  const previousBest = bootstrap.highScores[baseResult.taskId] ?? 0;
  const result: BrainPetTaskResult = {
    ...baseResult,
    quality: quality.snapshot(clock.pausedDuration(performance.now())),
    petEvents: ["complete", ...(baseResult.correct > baseResult.incorrect ? ["stable" as const] : []), ...(baseResult.score > previousBest ? ["new-best" as const] : [])],
  };
  activeTask = null;
  stagePhase = "result";
  lastFinishedResult = result;
  bridge.report({ type: "session-finished", result });
  logStageEvent("session-finished", result);
  playSound("finish");
  renderResult(result);
}

function renderResult(result: BrainPetTaskResult): void {
  const previousBest = bootstrap.levelHighScore;
  const best = Math.max(previousBest, result.score);
  const isNewBest = sessionOutcome?.isNewLevelBest ?? result.score > previousBest;
  const passed = sessionOutcome?.passed;
  const todayCompleted = sessionOutcome?.todayCompleted ?? bootstrap.todayCompleted + 1;
  const focusMode = bootstrap.mode !== "stage-exerciser";
  const goTrials = result.trials.filter((trial) => trial.stimulusKind === "go");
  const noGoTrials = result.trials.filter((trial) => trial.stimulusKind === "no-go");
  const goHits = goTrials.filter((trial) => trial.correct).length;
  const correctInhibitions = noGoTrials.filter((trial) => trial.correct).length;
  root.innerHTML = `<section class="stage-card result-card ${passed ? "result-pass" : passed === false ? "result-retry" : "result-settling"} ${isNewBest ? "result-new-best" : ""}${focusMode ? " focus-result" : ""}">
    ${focusMode ? "" : chrome(`第 ${result.level} 关`, passed === undefined ? "SETTLING" : passed ? "CLEAR" : "RETRY")}
    ${focusMode ? `<div class="result-content minimal-result reaction-panel" data-action="again" role="button" tabindex="0"><span>抑制 ${correctInhibitions}/${noGoTrials.length} · 命中 ${goHits}/${goTrials.length}</span><strong>${result.meanReactionTimeMs === null ? "—" : `${result.meanReactionTimeMs}ms`} · ${result.score}分</strong></div>` : `<div class="result-content" data-rig-drag-surface="true">
      <p class="pixel-kicker">${passed === undefined ? "CHECKING..." : passed ? "QUEST CLEAR!" : "再试一次就好"}</p>
      <div class="result-pet" aria-hidden="true">${petSprite(passed ? "celebrate" : "idle")}</div>
      <div class="score-medal"><span>SCORE</span><strong>${result.score}</strong></div>
      <p class="best-score">${isNewBest ? "NEW BEST" : "LEVEL BEST"} · ${best}</p>
      <p class="daily-stamp">今日已完成 ${todayCompleted} 关${passed ? ` · 下一关 ${sessionOutcome?.nextLevel}` : ""}</p>
      ${agentCompletionPending ? `<p class="agent-notice">AGENT 已完成 · 本局没有被打断</p>` : ""}
      <div class="result-stats"><span><b>${result.correct}</b>正确</span><span><b>${result.incorrect}</b>失误</span><span><b>${result.missed}</b>漏答</span></div>
      ${result.quality.flags.length ? `<p class="quality-note">本局记录：${result.quality.flags.map(qualityFlagLabel).join("、")}</p>` : ""}
      <div class="result-actions"><button class="pixel-button primary" data-action="again">再试本关</button><button class="pixel-button" data-action="done">收工</button></div>
      <p class="auto-close">4 秒后自动收起</p>
    </div>`}
  </section>`;
  bindChrome();
  root.querySelector("[data-action='again']")?.addEventListener("click", () => {
    bootstrap = { ...bootstrap, highScores: { ...bootstrap.highScores, [result.taskId]: Math.max(bootstrap.highScores[result.taskId] ?? 0, result.score) }, levelHighScore: best, todayCompleted, lastResult: result };
    bridge.report({ type: "settled" });
    void bridge.nextSession(result.taskId, result.level).then((session) => startTask(session));
  });
  root.querySelector("[data-action='done']")?.addEventListener("click", () => bridge.close());
  resultCloseTimer = window.setTimeout(() => bridge.close(), 4_000);
}

function handleHostEvent(event: Parameters<Parameters<Window["brainPet"]["onHostEvent"]>[0]>[0]): void {
  if (event.type === "rig-geometry-changed") {
    bootstrap = { ...bootstrap, rig: event.rig };
    applyRigGeometry(event.rig);
    return;
  }
  if (event.type === "rig-drag-start") {
    bootstrap = { ...bootstrap, rig: event.rig };
    applyRigGeometry(event.rig);
    setPauseReason("rig-drag", true);
    logStageEvent("rig-drag-start", { source: event.source, sequence: event.rig.sequence });
    return;
  }
  if (event.type === "rig-drag-end") {
    bootstrap = { ...bootstrap, rig: event.rig };
    applyRigGeometry(event.rig);
    const restarted = activeTask?.restartActiveTrial(logicalNow(performance.now())) ?? false;
    setPauseReason("rig-drag", false);
    setPauseReason("focus", false);
    logStageEvent("rig-drag-end", { source: event.source, sequence: event.rig.sequence, restartedActiveTrial: restarted });
    return;
  }
  if (event.type === "rig-invalidated") {
    bootstrap = { ...bootstrap, rig: event.rig };
    applyRigGeometry(event.rig);
    setPauseReason("rig-drag", true);
    logStageEvent("rig-invalidated", { reason: event.reason, sequence: event.rig.sequence });
    return;
  }
  if (event.type === "agent-completed") {
    if (activeTask) {
      agentCompletionPending = true;
      logStageEvent("agent-completed", { surface: event.surface, policy: "defer-until-result" });
    }
    return;
  }
  if (event.type === "session-outcome") {
    sessionOutcome = event;
    if (stagePhase === "result" && lastFinishedResult) renderResult(lastFinishedResult);
    return;
  }
  setPauseReason("host", event.type === "pause");
}

function chrome(title: string, status: string): string {
  return `<header class="window-bar"><span class="brand-gem" aria-hidden="true">B</span><strong>${escapeHtml(title)}</strong><em>${escapeHtml(status)}</em><button data-setting="sound" aria-label="${settings.soundEnabled ? "关闭" : "开启"}音效">${settings.soundEnabled ? "♪" : "×♪"}</button><button data-setting="motion" aria-label="${settings.reducedMotion ? "开启" : "降低"}动画">${settings.reducedMotion ? "▮" : "▶"}</button><button data-setting="contrast" aria-label="${settings.highContrast ? "关闭" : "开启"}高辨识模式">◐</button><button data-action="close" aria-label="关闭训练">×</button></header>`;
}

function bindChrome(): void {
  root.querySelector("[data-action='close']")?.addEventListener("click", () => bridge.close());
  root.querySelector("[data-setting='sound']")?.addEventListener("click", () => updateSettings({ soundEnabled: !settings.soundEnabled }));
  root.querySelector("[data-setting='motion']")?.addEventListener("click", () => updateSettings({ reducedMotion: !settings.reducedMotion }));
  root.querySelector("[data-setting='contrast']")?.addEventListener("click", () => updateSettings({ highContrast: !settings.highContrast }));
}

function updatePointerInteractivity(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target.closest(INTERACTIVE_SELECTOR) : null;
  setPointerInteractive(Boolean(target));
}

function setPointerInteractive(interactive: boolean): void {
  if (pointerInteractive === interactive) return;
  pointerInteractive = interactive;
  document.documentElement.dataset.pointerInteractive = interactive ? "true" : "false";
  bridge.setInteractive(interactive);
}

function handleRigPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || rigPointer || !(event.target instanceof Element)) return;
  const surface = event.target.closest<HTMLElement>("[data-rig-drag-surface]");
  if (!surface || event.target.closest(".window-bar, footer, .dev-tools, .result-actions, [data-setting], [data-action='close'], [data-action='pause'], [data-action='done']")) return;
  const inputSurface = event.target.closest<HTMLElement>("[data-scene-input], [data-rig-projectile-input]");
  const declaredInput = inputSurface?.dataset.sceneInput ?? inputSurface?.dataset.rigProjectileInput;
  rigPointer = {
    pointerId: event.pointerId,
    start: { screenX: event.screenX, screenY: event.screenY },
    input: declaredInput === "secondary" ? "secondary" : declaredInput === "primary" ? "primary" : null,
    dragging: false,
  };
  try { surface.setPointerCapture?.(event.pointerId); } catch { /* synthetic checks may not own a native pointer */ }
}

function handleRigPointerMove(event: PointerEvent): void {
  const pointer = rigPointer;
  if (!pointer || pointer.pointerId !== event.pointerId) return;
  const point = { screenX: event.screenX, screenY: event.screenY };
  if (!pointer.dragging) {
    if (!hasBrainPetRigDragStarted(pointer.start, point)) return;
    pointer.dragging = true;
    setPointerInteractive(true);
    setPauseReason("rig-drag", true);
    bridge.beginRigDrag(pointer.start);
  }
  event.preventDefault();
  bridge.moveRigDrag(point);
}

function handleRigPointerEnd(event: PointerEvent): void {
  const pointer = rigPointer;
  if (!pointer || pointer.pointerId !== event.pointerId) return;
  rigPointer = null;
  if (event.type === "pointercancel") return;
  if (!pointer.dragging && pointer.input) {
    event.preventDefault();
    suppressRigClickUntil = performance.now() + 350;
    sendInput(pointer.input);
    return;
  }
  if (!pointer.dragging) return;
  event.preventDefault();
  suppressRigClickUntil = performance.now() + 350;
  bridge.endRigDrag();
}

function suppressClickAfterRigDrag(event: MouseEvent): void {
  if (performance.now() > suppressRigClickUntil) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function applyRigGeometry(rig: Awaited<ReturnType<Window["brainPet"]["getBootstrap"]>>["rig"]): void {
  const stageX = rig.stageBoundsScreen.x - rig.overlayBoundsScreen.x;
  const stageY = rig.stageBoundsScreen.y - rig.overlayBoundsScreen.y;
  const style = document.documentElement.style;
  style.setProperty("--brainpet-playfield-x", `${stageX}px`);
  style.setProperty("--brainpet-playfield-y", `${stageY}px`);
  style.setProperty("--brainpet-playfield-width", `${rig.stageBoundsScreen.width}px`);
  style.setProperty("--brainpet-playfield-height", `${rig.stageBoundsScreen.height}px`);
  style.setProperty("--brainpet-throw-origin-x", `${rig.throwOriginOverlay.x}px`);
  style.setProperty("--brainpet-throw-origin-y", `${rig.throwOriginOverlay.y}px`);
  style.setProperty("--brainpet-reaction-x", `${rig.reactionBoundsScreen.x - rig.stageBoundsScreen.x}px`);
  style.setProperty("--brainpet-reaction-y", `${rig.reactionBoundsScreen.y - rig.stageBoundsScreen.y}px`);
  style.setProperty("--brainpet-reaction-width", `${rig.reactionBoundsScreen.width}px`);
  style.setProperty("--brainpet-reaction-height", `${rig.reactionBoundsScreen.height}px`);
  document.documentElement.dataset.rigDragging = rig.dragging ? "true" : "false";
  document.documentElement.dataset.rigSequence = String(rig.sequence);
}

function animatePetThrowForScene(scene: StageScene | undefined): void {
  const projectileId = scene?.rigProjectiles?.[0]?.id;
  if (!projectileId || projectileId === lastAnimatedProjectileId) return;
  lastAnimatedProjectileId = projectileId;
  bridge.animatePetThrow(projectileId);
}

function handleKeyDown(event: KeyboardEvent): void {
  if (stagePhase === "intro" && event.code === "Space") {
    event.preventDefault();
    skipIntro();
    return;
  }
  if (event.code === "Escape") {
    bridge.close();
    return;
  }
  if (event.code === "KeyP") {
    togglePause();
    return;
  }
  if (event.code === "Space" || event.code === "ArrowLeft") {
    event.preventDefault();
    sendInput("primary");
  } else if (event.code === "ArrowRight") {
    event.preventDefault();
    sendInput("secondary");
  }
}

function sendInput(type: "primary" | "secondary"): void {
  if (!activeTask || clock.paused) return;
  const atMs = logicalNow(performance.now());
  activeTask.input({ type, atMs });
  logStageEvent("input", { type, atMs });
}

function togglePause(): void {
  if (!activeTask) return;
  setPauseReason("manual", !pauseReasons.has("manual"));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function petSprite(state: "idle" | "celebrate"): string {
  const source = bootstrap.petSpriteUrl ?? defaultPetSpritesheetUrl;
  return `<img class="pet-sprite pet-sprite-${state}" src="${escapeHtml(source)}" alt="">`;
}

function requireRoot(): HTMLElement {
  const element = document.querySelector<HTMLElement>("#brainpet-root");
  if (!element) throw new Error("BrainPet stage root is missing.");
  return element;
}

function logicalNow(now: number): number {
  return clock.now(now);
}

function setPauseReason(reason: PauseReason, active: boolean): void {
  if (!activeTask) return;
  const hadReason = pauseReasons.has(reason);
  const wasPaused = pauseReasons.size > 0;
  if (active) pauseReasons.add(reason);
  else pauseReasons.delete(reason);
  const now = performance.now();
  const isPaused = pauseReasons.size > 0;
  if (!wasPaused && isPaused) {
    clock.pause(now);
    quality.resetFrameAnchor();
    if (reason === "focus" || reason === "visibility" || reason === "host") quality.focusLost();
    bridge.report({ type: "pause-requested" });
    logStageEvent("paused", { reason });
  } else if (wasPaused && !isPaused) {
    clock.resume(now);
    quality.resetFrameAnchor();
    bridge.report({ type: "resume-requested" });
    logStageEvent("resumed", { reason });
  }
  if (wasPaused !== isPaused || hadReason !== active) renderTask();
}

function replayFixedSeed(): void {
  const input = root.querySelector<HTMLInputElement>("[data-dev='seed']");
  const parsed = Number.parseInt(input?.value ?? "", 10);
  if (Number.isInteger(parsed)) seed = parsed >>> 0 || 1;
  void startTask({ ...currentSession, taskId: "stage-exerciser", seed, level: 1 });
}

function renderStageScene(scene: StageScene): string {
  const layers = [...scene.layers].sort((left, right) => left.z - right.z).map((layer) => {
    const sprites = layer.sprites.map((sprite) => {
      const asset = loadedAssets.get(sprite.assetId);
      const style = `left:${sprite.x}%;top:${sprite.y}%;${asset ? `background-image:url(&quot;${escapeHtml(asset.resolvedUrl)}&quot;)` : ""}`;
      const content = escapeHtml(sprite.text ?? "");
      const assetId = escapeHtml(sprite.assetId);
      return sprite.input
        ? `<button class="scene-sprite scene-target" data-asset="${assetId}" data-scene-input="${sprite.input}" style="${style}" aria-label="${escapeHtml(sprite.ariaLabel ?? sprite.text ?? sprite.input)}">${content}</button>`
        : `<span class="scene-sprite" data-asset="${assetId}" style="${style}"${sprite.ariaLabel ? ` aria-label="${escapeHtml(sprite.ariaLabel)}"` : ""}>${content}</span>`;
    }).join("");
    return `<div class="scene-layer" data-layer="${escapeHtml(layer.id)}" style="z-index:${layer.z}">${sprites}</div>`;
  }).join("");
  const particles = scene.particles.map((particle) => `<i class="scene-particle" style="left:${particle.x}%;top:${particle.y}%;--particle-life:${particle.lifetimeMs}ms"></i>`).join("");
  return `<div class="stage-scene" data-scene="${escapeHtml(scene.id)}" style="--scene-zoom:${scene.camera.zoom}">${layers}${particles}</div>`;
}

function renderRigProjectiles(scene: StageScene): string {
  if (!scene.rigProjectiles?.length) return "";
  const rig = bootstrap.rig;
  const start = {
    x: rig.throwOriginScreen.x - rig.stageBoundsScreen.x,
    y: rig.throwOriginScreen.y - rig.stageBoundsScreen.y,
  };
  const end = {
    x: rig.reactionBoundsScreen.x + rig.reactionBoundsScreen.width / 2 - rig.stageBoundsScreen.x,
    y: rig.reactionBoundsScreen.y + rig.reactionBoundsScreen.height / 2 - rig.stageBoundsScreen.y,
  };
  return scene.rigProjectiles.map((projectile) => {
    const asset = loadedAssets.get(projectile.assetId);
    const progress = Math.min(1, Math.max(0, projectile.progress));
    const inverse = 1 - progress;
    const control = { x: (start.x + end.x) / 2 + (projectile.curveOffsetPx ?? 0), y: Math.min(start.y, end.y) - projectile.arcHeightPx };
    const x = inverse * inverse * start.x + 2 * inverse * progress * control.x + progress * progress * end.x;
    const y = inverse * inverse * start.y + 2 * inverse * progress * control.y + progress * progress * end.y;
    const rotation = progress * (projectile.spinTurns ?? 0) * 360;
    const style = `left:${x}px;top:${y}px;--rig-rotation:${rotation.toFixed(1)}deg;${asset ? `background-image:url(&quot;${escapeHtml(asset.resolvedUrl)}&quot;)` : ""}`;
    const assetId = escapeHtml(projectile.assetId);
    if (projectile.input) {
      return `<button class="rig-projectile" data-rig-drag-surface="true" data-rig-progress="${progress.toFixed(3)}" data-asset="${assetId}" data-rig-projectile-input="${projectile.input}" style="${style}" aria-label="${escapeHtml(projectile.ariaLabel ?? projectile.input)}"></button>`;
    }
    return `<span class="rig-projectile" data-rig-progress="${progress.toFixed(3)}" data-asset="${assetId}" style="${style}"${projectile.ariaLabel ? ` aria-label="${escapeHtml(projectile.ariaLabel)}"` : ""}></span>`;
  }).join("");
}

function loadStageAsset(url: string, declaration: { readonly kind: "sprite" | "sound" }): Promise<void> {
  if (declaration.kind === "sound") {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      audio.preload = "auto";
      audio.addEventListener("canplaythrough", () => resolve(), { once: true });
      audio.addEventListener("error", () => reject(new Error("Stage sound failed to load.")), { once: true });
      audio.src = url;
      audio.load();
    });
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => reject(new Error("Stage sprite failed to load.")), { once: true });
    image.src = url;
  });
}

function exportEventLog(): void {
  const payload = JSON.stringify({ apiVersion: 1, seed, exportedAt: new Date().toISOString(), events: eventLog }, null, 2);
  console.info(`BRAINPET_EVENT_EXPORT ${payload}`);
  void navigator.clipboard?.writeText(payload).catch(() => undefined);
}

function logStageEvent(type: string, details?: unknown): void {
  eventLog.push({ type, atMs: performance.now(), ...(details === undefined ? {} : { details }) });
  if (eventLog.length > 512) eventLog = eventLog.slice(-512);
}

function updateSettings(patch: Partial<BrainPetStageSettings>): void {
  settings = { ...settings, ...patch };
  saveStageSettings(localStorage, settings);
  applySettings();
  if (activeTask) renderTask();
  else if (stagePhase === "intro") renderIntro(currentSession);
  else if (lastFinishedResult) renderResult(lastFinishedResult);
}

function applySettings(): void {
  document.documentElement.dataset.reducedMotion = settings.reducedMotion ? "true" : "false";
  document.documentElement.dataset.highContrast = settings.highContrast ? "true" : "false";
}

function playSound(kind: "start" | "correct" | "incorrect" | "finish"): void {
  if (!settings.soundEnabled) return;
  try {
    const AudioContextClass = window.AudioContext;
    const context = audioContext ??= new AudioContextClass();
    if (context.state === "suspended") void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const frequencies = { start: 440, correct: 660, incorrect: 180, finish: 880 } as const;
    oscillator.type = "square";
    oscillator.frequency.value = frequencies[kind];
    gain.gain.setValueAtTime(0.035, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.09);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.1);
  } catch {
    // Audio is optional feedback; the visual path remains complete when unavailable.
  }
}

function qualityLabel(): string {
  const snapshot = quality.snapshot(clock.pausedDuration(performance.now()));
  return `60FPS · DROP ${snapshot.droppedFrameCount} · PAUSE ${Math.round(snapshot.pausedMs / 1000)}s`;
}

function qualityFlagLabel(flag: string): string {
  if (flag === "focus-lost") return "曾失焦，已暂停计时";
  if (flag === "long-frame") return "检测到卡顿";
  if (flag === "excessive-frame-loss") return "帧率异常，成绩不计有效";
  return flag;
}

function getBridge(): Window["brainPet"] {
  if (window.brainPet) return window.brainPet;
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") throw new Error("BrainPet bridge is unavailable.");
  const query = new URLSearchParams(location.search);
  const previewSeed = Number.parseInt(query.get("seed") ?? "2", 10) || 2;
  return {
    async getBootstrap() {
      const mode = query.get("mode") === "exerciser" ? "stage-exerciser" : "training";
      const requestedTask = query.get("task");
      const taskId: BrainPetTaskId = mode === "stage-exerciser" ? "stage-exerciser" : listPlayableBrainPetTaskIds().find((candidate) => candidate === requestedTask) ?? listPlayableBrainPetTaskIds()[0];
      const manifest = getBrainPetTaskManifest(taskId);
      const level = Number.parseInt(query.get("level") ?? "1", 10) || 1;
      return { apiVersion: 1, mode, suggestedSeed: previewSeed, session: { taskId, seed: previewSeed, durationMs: manifest.durationMs, level, difficultyPolicyVersion: manifest.difficulty.policyVersion, parameterVersion: manifest.difficulty.parameterVersion, parameters: getBrainPetDifficultyParameters(taskId, level), blockCount: manifest.difficulty.blockCount }, availableTasks: listPlayableBrainPetTaskIds(), lastResult: null, highScores: {}, levelHighScore: 0, todayCompleted: 0, petSpriteUrl: null, rig: { apiVersion: 1, rigId: "preview-rig", petWindowId: 0, petBoundsScreen: { x: 500, y: 380, width: 140, height: 140 }, stageBoundsScreen: { x: 0, y: 0, width: 640, height: 360 }, overlayBoundsScreen: { x: 0, y: 0, width: 656, height: 536 }, reactionBoundsScreen: { x: 230, y: 90, width: 180, height: 180 }, throwOriginScreen: { x: 570, y: 422 }, throwOriginOverlay: { x: 570, y: 422 }, displayId: "preview", scaleFactor: 1, dragging: false, sequence: 1, atMs: 0 } };
    },
    async nextSession(taskId, level) {
      const manifest = getBrainPetTaskManifest(taskId);
      const nextSeed = (seed + 0x9e3779b9) >>> 0 || 1;
      return { taskId, seed: nextSeed, durationMs: manifest.durationMs, level, difficultyPolicyVersion: manifest.difficulty.policyVersion, parameterVersion: manifest.difficulty.parameterVersion, parameters: getBrainPetDifficultyParameters(taskId, level), blockCount: manifest.difficulty.blockCount };
    },
    ready() {},
    report() {},
    setInteractive() {},
    animatePetThrow() {},
    beginRigDrag() {},
    moveRigDrag() {},
    endRigDrag() {},
    close() {},
    onHostEvent() { return () => {}; },
  };
}
