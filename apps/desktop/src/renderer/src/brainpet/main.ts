import type { BrainPetTaskId, BrainPetTaskResult, BrainPetTaskSessionConfig } from "../../../brainpet/task-contract";
import { createTaskModule, type BrainPetTaskModule } from "./task-modules";
import "./stage.css";

const root = requireRoot();

let activeTask: BrainPetTaskModule | null = null;
let animationFrame = 0;
let paused = false;
let seed = 1;
let bootstrap: Awaited<ReturnType<typeof window.brainPet.getBootstrap>>;
let pauseStartedAt: number | null = null;
let accumulatedPauseMs = 0;
let lastRenderedAt = 0;
const bridge = getBridge();

void initialize();

async function initialize(): Promise<void> {
  bootstrap = await bridge.getBootstrap();
  seed = bootstrap.suggestedSeed;
  renderWelcome();
  bridge.ready();
  window.addEventListener("keydown", handleKeyDown);
}

function renderWelcome(): void {
  const previous = bootstrap.lastResult;
  root.innerHTML = `<section class="stage-card welcome-card">
    ${chrome("旅行训练站", "WAIT MODE")}
    <div class="sky-layer" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="welcome-copy">
      <p class="pixel-kicker">BRAINPET · BREAK QUEST</p>
      <h1>来一局，脑袋动起来</h1>
      <p>约 45 秒，随机送来一项轻量训练。</p>
      ${previous ? `<div class="last-score"><span>上次得分</span><strong>${previous.score}</strong></div>` : ""}
      <button class="pixel-button primary" data-action="start">开始随机任务 <span>▶</span></button>
      <span class="microcopy">空格开始 · 随时关闭 · 不打断 Agent</span>
    </div>
    <div class="platform" aria-hidden="true"><span class="pet-scout">B</span><i></i><i></i><i></i></div>
  </section>`;
  bindChrome();
  root.querySelector("[data-action='start']")?.addEventListener("click", startRandomTask);
}

function startRandomTask(): void {
  const taskId: BrainPetTaskId = bootstrap.mode === "stage-exerciser"
    ? "stage-exerciser"
    : bootstrap.availableTasks[seed % bootstrap.availableTasks.length]!;
  startTask(taskId);
}

function startTask(taskId: BrainPetTaskId): void {
  cancelAnimationFrame(animationFrame);
  activeTask = createTaskModule(taskId);
  const now = performance.now();
  activeTask.start(seed, 1, now);
  const session: BrainPetTaskSessionConfig = { taskId, seed, durationMs: activeTask.manifest.durationMs, level: 1 };
  bridge.report({ type: "session-started", session });
  paused = false;
  pauseStartedAt = null;
  accumulatedPauseMs = 0;
  lastRenderedAt = 0;
  renderTask();
  animationFrame = requestAnimationFrame(tick);
}

function tick(now: number): void {
  if (!activeTask) return;
  const taskNow = logicalNow(now);
  if (!paused) activeTask.tick(taskNow);
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
  root.innerHTML = `<section class="stage-card task-card tone-${frame.tone} feedback-${frame.feedback ?? "neutral"}">
    ${chrome(task.manifest.title, paused ? "PAUSED" : "TRAINING")}
    <div class="hud"><span>${escapeHtml(frame.eyebrow)}</span><strong>${frame.score.toString().padStart(4, "0")}</strong></div>
    <div class="progress-track"><i style="width:${Math.round(frame.progress * 100)}%"></i></div>
    <div class="task-layout">
      <div class="task-copy"><h1>${escapeHtml(frame.title)}</h1><p>${escapeHtml(frame.instruction)}</p></div>
      <div class="stimulus" data-action="primary"><span>${escapeHtml(frame.symbol)}</span></div>
      ${frame.slots ? `<div class="memory-slots">${frame.slots.map((slot) => `<i>${escapeHtml(slot)}</i>`).join("")}</div>` : ""}
      ${frame.choices ? `<div class="choice-row">${frame.choices.map((choice, index) => `<button data-choice="${index}"><kbd>${index === 0 ? "←" : "→"}</kbd>${escapeHtml(choice)}</button>`).join("")}</div>` : ""}
      ${frame.feedbackText ? `<div class="feedback-toast">${escapeHtml(frame.feedbackText)}</div>` : ""}
    </div>
    <footer><span>SPACE / CLICK</span><button data-action="pause">${paused ? "继续" : "暂停"}</button></footer>
  </section>`;
  bindChrome();
  root.querySelector("[data-action='primary']")?.addEventListener("click", () => sendInput("primary"));
  root.querySelector("[data-choice='0']")?.addEventListener("click", () => sendInput("primary"));
  root.querySelector("[data-choice='1']")?.addEventListener("click", () => sendInput("secondary"));
  root.querySelector("[data-action='pause']")?.addEventListener("click", togglePause);
}

function finishTask(now: number): void {
  const task = activeTask;
  if (!task) return;
  const result = task.result(now);
  activeTask = null;
  bridge.report({ type: "session-finished", result });
  renderResult(result);
}

function renderResult(result: BrainPetTaskResult): void {
  const previousBest = bootstrap.highScores[result.taskId] ?? 0;
  const best = Math.max(previousBest, result.score);
  const isNewBest = result.score > previousBest;
  root.innerHTML = `<section class="stage-card result-card">
    ${chrome("本轮完成", "RESULT")}
    <div class="result-content">
      <p class="pixel-kicker">QUEST CLEAR!</p>
      <div class="score-medal"><span>SCORE</span><strong>${result.score}</strong></div>
      <p class="best-score">${isNewBest ? "NEW BEST" : "PERSONAL BEST"} · ${best}</p>
      <div class="result-stats"><span><b>${result.correct}</b>正确</span><span><b>${result.incorrect}</b>失误</span><span><b>${result.missed}</b>漏答</span></div>
      <div class="result-actions"><button class="pixel-button primary" data-action="again">再来随机一局</button><button class="pixel-button" data-action="done">收工</button></div>
    </div>
  </section>`;
  bindChrome();
  root.querySelector("[data-action='again']")?.addEventListener("click", () => {
    bootstrap = { ...bootstrap, highScores: { ...bootstrap.highScores, [result.taskId]: best }, lastResult: result };
    bridge.report({ type: "settled" });
    seed = (seed + 0x9e3779b9) >>> 0 || 1;
    startRandomTask();
  });
  root.querySelector("[data-action='done']")?.addEventListener("click", () => bridge.close());
}

function chrome(title: string, status: string): string {
  return `<header class="window-bar"><span class="brand-gem" aria-hidden="true">B</span><strong>${escapeHtml(title)}</strong><em>${escapeHtml(status)}</em><button data-action="close" aria-label="关闭训练">×</button></header>`;
}

function bindChrome(): void {
  root.querySelector("[data-action='close']")?.addEventListener("click", () => bridge.close());
}

function handleKeyDown(event: KeyboardEvent): void {
  if (!activeTask && event.code === "Space") {
    event.preventDefault();
    startRandomTask();
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
  if (!activeTask || paused) return;
  activeTask.input({ type, atMs: logicalNow(performance.now()) });
}

function togglePause(): void {
  if (!activeTask) return;
  const now = performance.now();
  paused = !paused;
  if (paused) pauseStartedAt = now;
  else if (pauseStartedAt !== null) {
    accumulatedPauseMs += now - pauseStartedAt;
    pauseStartedAt = null;
  }
  bridge.report({ type: paused ? "pause-requested" : "resume-requested" });
  renderTask();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function requireRoot(): HTMLElement {
  const element = document.querySelector<HTMLElement>("#brainpet-root");
  if (!element) throw new Error("BrainPet stage root is missing.");
  return element;
}

function logicalNow(now: number): number {
  const frozenAt = paused && pauseStartedAt !== null ? pauseStartedAt : now;
  return frozenAt - accumulatedPauseMs;
}

function getBridge(): Window["brainPet"] {
  if (window.brainPet) return window.brainPet;
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") throw new Error("BrainPet bridge is unavailable.");
  const query = new URLSearchParams(location.search);
  const previewSeed = Number.parseInt(query.get("seed") ?? "2", 10) || 2;
  return {
    async getBootstrap() {
      return { apiVersion: 1, mode: query.get("mode") === "exerciser" ? "stage-exerciser" : "training", suggestedSeed: previewSeed, availableTasks: ["cargo-signal", "pack-refresh"], lastResult: null, highScores: {} };
    },
    ready() {},
    report() {},
    close() {},
  };
}
