import { EventEmitter } from "node:events";

import { net, powerMonitor, screen } from "electron";

import { debug } from "./logger.js";
import { subscribeHostAgentActivity } from "./host-agent-activity.js";
import { registerPluginSystemEventListeners } from "./plugin-event-listeners.js";

/**
 * The senses bus host source (§3): a curated, read-only event stream fed by
 * the pet windows, powerMonitor, screen, and small pollers. Plugins subscribe
 * through the SDK bridge; the bridge enforces the permission and the bounded
 * event-name set. Hard privacy line (§3.1): nothing here ever carries
 * keystrokes, screen contents, other apps' window titles, or clipboard data.
 */

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let started = false;
let idleTimer: NodeJS.Timeout | null = null;
let dayPartTimer: NodeJS.Timeout | null = null;
let onlineTimer: NodeJS.Timeout | null = null;
let userIsIdle = false;
let lastOnline: boolean | null = null;
let lastDayPart: string | null = null;
let unsubscribeHostAgentActivity: (() => void) | null = null;
let removeSystemEventListeners: (() => void) | null = null;

const idleThresholdSeconds = 120;
const idlePollMs = 15_000;
const onlinePollMs = 30_000;

export type PluginEventHandler = (payload: Record<string, unknown>) => void;

/** Subscribe to a curated event. Returns an unsubscribe function. */
export function subscribePluginEvent(event: string, handler: PluginEventHandler): () => void {
  emitter.on(event, handler);
  return () => emitter.off(event, handler);
}

/** Emit an event into the bus (host-internal producers only). */
export function emitPluginEvent(event: string, payload: Record<string, unknown>): void {
  try { emitter.emit(event, payload); } catch { /* subscriber errors are isolated upstream */ }
}

const petWindowEventNames = new Set(["pet:clicked", "pet:doubleClicked", "pet:dragStart", "pet:dragEnd", "pet:hover", "pet:drop"]);
let nextDropFileId = 0;
const droppedFileTexts = new Map<string, { text: string; expiresAt: number }>();

/** Read a dropped file's cached text (one-shot accessor backing, §13.7). */
export function readDroppedFileText(fileId: string): string | undefined {
  const entry = droppedFileTexts.get(fileId);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { droppedFileTexts.delete(fileId); return undefined; }
  return entry.text;
}

/** Pet windows publish their senses through this (clicks, hovers, drops). */
export function publishPluginPetEvent(petId: string, name: string, payload: Record<string, unknown>): void {
  if (!petWindowEventNames.has(name)) return;
  if (name === "pet:drop") {
    const kind = payload.kind === "files" ? "files" : "text";
    if (kind === "text") {
      const text = typeof payload.text === "string" ? payload.text.slice(0, 256 * 1024) : "";
      if (!text) return;
      emitPluginEvent("pet:drop", { kind: "text", text, petId });
      return;
    }
    const dropped = Array.isArray(payload.droppedFiles) ? payload.droppedFiles.slice(0, 4) : [];
    const files = dropped.flatMap((file) => {
      if (typeof file !== "object" || file === null) return [];
      const record = file as Record<string, unknown>;
      const fileId = `drop-${++nextDropFileId}`;
      const text = typeof record.text === "string" ? record.text.slice(0, 5 * 1024 * 1024) : "";
      droppedFileTexts.set(fileId, { text, expiresAt: Date.now() + 10 * 60_000 });
      return [{ fileId, name: typeof record.name === "string" ? record.name.slice(0, 200) : "file", sizeBytes: Number(record.sizeBytes) || text.length }];
    });
    if (files.length === 0) return;
    emitPluginEvent("pet:drop", { kind: "files", files, petId });
    return;
  }
  emitPluginEvent(name, { petId });
}

function currentDayPart(date = new Date()): "morning" | "afternoon" | "evening" | "night" {
  const hour = date.getHours();
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

/** Start the host-side event producers. Idempotent; call once from main. */
export function startPluginEventSources(): void {
  if (started) return;
  debug("plugin", "event sources starting");
  let localUnsubscribe: (() => void) | null = null;
  let localRemoveListeners: (() => void) | null = null;
  let localIdleTimer: NodeJS.Timeout | null = null;
  let localDayPartTimer: NodeJS.Timeout | null = null;
  let localOnlineTimer: NodeJS.Timeout | null = null;
  try {
    localUnsubscribe = subscribeHostAgentActivity((payload) => emitPluginEvent("agent:activity", payload as unknown as Record<string, unknown>));
    localRemoveListeners = registerPluginSystemEventListeners(powerMonitor, screen, {
      lockScreen: () => emitPluginEvent("screen:locked", {}),
      unlockScreen: () => emitPluginEvent("screen:unlocked", {}),
      onBattery: () => emitPluginEvent("power:charging", { charging: false }),
      onAc: () => emitPluginEvent("power:charging", { charging: true }),
      suspend: () => { userIsIdle = true; },
      resume: () => { userIsIdle = false; },
      displayChanged: () => emitPluginEvent("display:changed", { displays: screen.getAllDisplays().length }),
    });
    localIdleTimer = setInterval(() => {
      try {
        const idleSeconds = powerMonitor.getSystemIdleTime();
        if (!userIsIdle && idleSeconds >= idleThresholdSeconds) {
          userIsIdle = true;
          emitPluginEvent("idle:enter", { idleSeconds });
        } else if (userIsIdle && idleSeconds < idleThresholdSeconds) {
          userIsIdle = false;
          emitPluginEvent("idle:exit", { idleSeconds });
        }
      } catch { /* idle probing is best-effort */ }
    }, idlePollMs);
    localIdleTimer.unref?.();

    lastDayPart = currentDayPart();
    localDayPartTimer = setInterval(() => {
      const part = currentDayPart();
      if (part !== lastDayPart) {
        lastDayPart = part;
        emitPluginEvent("day:partChanged", { part });
      }
    }, 60_000);
    localDayPartTimer.unref?.();

    lastOnline = net.online;
    localOnlineTimer = setInterval(() => {
      const online = net.online;
      if (lastOnline !== null && online !== lastOnline) emitPluginEvent(online ? "online" : "offline", {});
      lastOnline = online;
    }, onlinePollMs);
    localOnlineTimer.unref?.();

    unsubscribeHostAgentActivity = localUnsubscribe;
    removeSystemEventListeners = localRemoveListeners;
    idleTimer = localIdleTimer;
    dayPartTimer = localDayPartTimer;
    onlineTimer = localOnlineTimer;
    started = true;
  } catch (error) {
    if (localIdleTimer) clearInterval(localIdleTimer);
    if (localDayPartTimer) clearInterval(localDayPartTimer);
    if (localOnlineTimer) clearInterval(localOnlineTimer);
    try { localRemoveListeners?.(); } catch { /* preserve the startup error */ }
    try { localUnsubscribe?.(); } catch { /* preserve the startup error */ }
    userIsIdle = false;
    lastOnline = null;
    lastDayPart = null;
    throw error;
  }
}

export function stopPluginEventSources(): void {
  if (idleTimer) clearInterval(idleTimer);
  if (dayPartTimer) clearInterval(dayPartTimer);
  if (onlineTimer) clearInterval(onlineTimer);
  idleTimer = dayPartTimer = onlineTimer = null;
  let firstError: unknown;
  try { removeSystemEventListeners?.(); } catch (error) { firstError ??= error; }
  removeSystemEventListeners = null;
  try { unsubscribeHostAgentActivity?.(); } catch (error) { firstError ??= error; }
  unsubscribeHostAgentActivity = null;
  userIsIdle = false;
  lastOnline = null;
  lastDayPart = null;
  droppedFileTexts.clear();
  started = false;
  if (firstError) throw firstError;
}
