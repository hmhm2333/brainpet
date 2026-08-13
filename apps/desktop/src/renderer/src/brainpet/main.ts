import type { BrainPetTaskId, BrainPetTaskResult, BrainPetTaskSessionConfig } from "../../../brainpet/task-contract";
import { getBrainPetDifficultyParameters, getBrainPetTaskManifest, listPlayableBrainPetTaskIds } from "../../../brainpet/task-registry";
import { createTaskModule, type BrainPetTaskModule } from "./task-modules";
import { LogicalSessionClock, StageQualityMonitor, loadStageSettings, saveStageSettings, type BrainPetStageSettings } from "./stage-runtime";
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
let agentCompletionPending = false;
let stagePhase: "intro" | "running" | "result" = "intro";
let currentSession: BrainPetTaskSessionConfig;
let lastFinishedResult: BrainPetTaskResult | null = null;
let sessionOutcome: Extract<Parameters<Parameters<Window["brainPet"]["onHostEvent"]>[0]>[0], { readonly type: "session-outcome" }> | null = null;
let settings: BrainPetStageSettings = loadStageSettings(localStorage);
let quality = new StageQualityMonitor();
let eventLog: Array<{ readonly type: string; readonly atMs: number; readonly details?: unknown }> = [];
const clock = new LogicalSessionClock();
const pauseReasons = new Set<"manual" | "focus" | "visibility" | "host">();
const bridge = getBridge();

void initialize();

async function initialize(): Promise<void> {
  bootstrap = await bridge.getBootstrap();
  currentSession = bootstrap.session;
  seed = currentSession.seed;
  renderIntro(currentSession);
  bridge.ready();
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("blur", () => setPauseReason("focus", true));
  window.addEventListener("focus", () => setPauseReason("focus", false));
  document.addEventListener("visibilitychange", () => setPauseReason("visibility", document.hidden));
  bridge.onHostEvent(handleHostEvent);
  applySettings();
  introTimer = window.setTimeout(() => startTask(currentSession), 1_400);
}

function renderIntro(session: BrainPetTaskSessionConfig): void {
  const manifest = getBrainPetTaskManifest(session.taskId);
  const manifestTitle = manifest.title;
  const rule = manifest.introRule;
  root.innerHTML = `<section class="stage-card welcome-card intro-card">
    ${chrome(manifestTitle, `LEVEL ${session.level}`)}
    <div class="sky-layer" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="welcome-copy">
      <p class="pixel-kicker">BRAINPET · QUEST ${session.level}</p>
      <h1>${escapeHtml(manifestTitle)}</h1>
      <p>${escapeHtml(rule)}</p>
      <div class="intro-countdown" aria-label="即将开始"><i></i><i></i><i></i></div>
      <span class="microcopy">自动开始 · 空格跳过 · Esc 退出</span>
    </div>
    <div class="platform" aria-hidden="true"><span class="pet-scout">${petSprite("idle")}</span><i></i><i></i><i></i></div>
  </section>`;
  bindChrome();
  root.querySelector(".stage-card")?.addEventListener("click", skipIntro);
}

function skipIntro(): void {
  if (stagePhase !== "intro") return;
  window.clearTimeout(introTimer);
  startTask(currentSession);
}

function startTask(session: BrainPetTaskSessionConfig): void {
  if (stagePhase === "running") return;
  window.clearTimeout(resultCloseTimer);
  window.clearTimeout(introTimer);
  cancelAnimationFrame(animationFrame);
  currentSession = session;
  seed = session.seed;
  activeTask = createTaskModule(session.taskId);
  const now = performance.now();
  activeTask.start(seed, session.level, now, session.parameters);
  bridge.report({ type: "session-started", session });
  stagePhase = "running";
  lastFinishedResult = null;
  sessionOutcome = null;
  agentCompletionPending = false;
  pauseReasons.clear();
  clock.reset();
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
  quality.frame(now);
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
  const renderKey = JSON.stringify({
    taskId: task.manifest.id,
    paused,
    eyebrow: frame.eyebrow,
    title: frame.title,
    instruction: frame.instruction,
    symbol: frame.symbol,
    tone: frame.tone,
    slots: frame.slots,
    choices: frame.choices,
    feedback: frame.feedback,
    feedbackText: frame.feedbackText,
    primarySurface: frame.primarySurface,
    combo: frame.combo,
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
  root.innerHTML = `<section class="stage-card task-card tone-${frame.tone} feedback-${frame.feedback ?? "neutral"}">
    ${chrome(task.manifest.title, paused ? "PAUSED" : "TRAINING")}
    <div class="hud"><span>${escapeHtml(frame.eyebrow)}</span>${(frame.combo ?? 0) >= 3 ? `<em>COMBO ×${frame.combo}</em>` : ""}<strong data-live="score">${frame.score.toString().padStart(4, "0")}</strong></div>
    <svg class="progress-track" viewBox="0 0 100 1" preserveAspectRatio="none" aria-label="进度 ${Math.round(frame.progress * 100)}%"><rect data-live="progress" x="0" y="0" width="${Math.round(frame.progress * 100)}" height="1"></rect></svg>
    <div class="task-layout">
      <div class="task-copy"><h1>${escapeHtml(frame.title)}</h1><p>${escapeHtml(frame.instruction)}</p></div>
      <div class="stimulus" data-action="primary"><span>${escapeHtml(frame.symbol)}</span></div>
      ${frame.slots ? `<div class="memory-slots">${frame.slots.map((slot) => `<i>${escapeHtml(slot)}</i>`).join("")}</div>` : ""}
      ${frame.choices ? `<div class="choice-row">${frame.choices.map((choice, index) => `<button data-choice="${index}"><kbd>${index === 0 ? "←" : "→"}</kbd>${escapeHtml(choice)}</button>`).join("")}</div>` : ""}
      ${frame.feedbackText ? `<div class="feedback-toast">${escapeHtml(frame.feedbackText)}</div>` : ""}
      ${bootstrap.mode === "stage-exerciser" ? `<aside class="dev-tools"><label>SEED <input data-dev="seed" inputmode="numeric" value="${seed}"></label><button data-dev="replay">固定 seed 重放</button><button data-dev="export">导出事件</button></aside>` : ""}
    </div>
    <footer><span>${bootstrap.mode === "stage-exerciser" ? qualityLabel() : "SPACE / CLICK"}</span><button data-action="pause">${paused ? "继续" : "暂停"}</button></footer>
  </section>`;
  bindChrome();
  if (frame.primarySurface === undefined) root.querySelector("[data-action='primary']")?.addEventListener("click", () => sendInput("primary"));
  if (frame.primarySurface) root.querySelector(".task-layout")?.addEventListener("click", (event) => { if (!(event.target as Element).closest("button")) sendInput("primary"); });
  root.querySelector("[data-choice='0']")?.addEventListener("click", () => sendInput("primary"));
  root.querySelector("[data-choice='1']")?.addEventListener("click", () => sendInput("secondary"));
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
  root.innerHTML = `<section class="stage-card result-card ${passed ? "result-pass" : passed === false ? "result-retry" : "result-settling"} ${isNewBest ? "result-new-best" : ""}">
    ${chrome(`第 ${result.level} 关`, passed === undefined ? "SETTLING" : passed ? "CLEAR" : "RETRY")}
    <div class="result-content">
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
    </div>
  </section>`;
  bindChrome();
  root.querySelector("[data-action='again']")?.addEventListener("click", () => {
    bootstrap = { ...bootstrap, highScores: { ...bootstrap.highScores, [result.taskId]: Math.max(bootstrap.highScores[result.taskId] ?? 0, result.score) }, levelHighScore: best, todayCompleted, lastResult: result };
    bridge.report({ type: "settled" });
    seed = (seed + 0x9e3779b9) >>> 0 || 1;
    startTask({ ...currentSession, seed });
  });
  root.querySelector("[data-action='done']")?.addEventListener("click", () => bridge.close());
  resultCloseTimer = window.setTimeout(() => bridge.close(), 4_000);
}

function handleHostEvent(event: Parameters<Parameters<Window["brainPet"]["onHostEvent"]>[0]>[0]): void {
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

function setPauseReason(reason: "manual" | "focus" | "visibility" | "host", active: boolean): void {
  if (!activeTask) return;
  const wasPaused = pauseReasons.size > 0;
  if (active) pauseReasons.add(reason);
  else pauseReasons.delete(reason);
  const now = performance.now();
  const isPaused = pauseReasons.size > 0;
  if (!wasPaused && isPaused) {
    clock.pause(now);
    quality.resetFrameAnchor();
    if (reason !== "manual") quality.focusLost();
    bridge.report({ type: "pause-requested" });
    logStageEvent("paused", { reason });
  } else if (wasPaused && !isPaused) {
    clock.resume(now);
    quality.resetFrameAnchor();
    bridge.report({ type: "resume-requested" });
    logStageEvent("resumed", { reason });
  }
  if (wasPaused !== isPaused) renderTask();
}

function replayFixedSeed(): void {
  const input = root.querySelector<HTMLInputElement>("[data-dev='seed']");
  const parsed = Number.parseInt(input?.value ?? "", 10);
  if (Number.isInteger(parsed)) seed = parsed >>> 0 || 1;
  startTask({ ...currentSession, taskId: "stage-exerciser", seed, level: 1 });
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
      return { apiVersion: 1, mode, suggestedSeed: previewSeed, session: { taskId, seed: previewSeed, durationMs: manifest.durationMs, level, difficultyPolicyVersion: manifest.difficulty.policyVersion, parameterVersion: manifest.difficulty.parameterVersion, parameters: getBrainPetDifficultyParameters(taskId, level), blockCount: manifest.difficulty.blockCount }, availableTasks: listPlayableBrainPetTaskIds(), lastResult: null, highScores: {}, levelHighScore: 0, todayCompleted: 0, petSpriteUrl: null };
    },
    ready() {},
    report() {},
    close() {},
    onHostEvent() { return () => {}; },
  };
}
