import { applyPrimaryCompanionLifecycle, setPrimaryCompanionActivitySummary } from "./default-pet-controller.js";
import { debug, info } from "./logger.js";
import { publishPluginAgentActivity } from "./plugin-events-source.js";
import { applyAgentLifecycleEvent, deriveAgentLifecyclePresentation, pruneStaleAgentLifecycleEntries, type AgentLifecycleEntry, type AgentLifecycleEvent, type AgentLifecyclePresentation } from "./agent-lifecycle.js";
import { agentCompanionActivityKey, deriveAgentCompanionActivitySummary, type AgentCompanionActivitySummary } from "./agent-companion-activity.js";

const staleAfterMs = 30 * 60_000;
const pruneIntervalMs = 60_000;

let entries = new Map<string, AgentLifecycleEntry>();
let currentPresentation: AgentLifecyclePresentation = deriveAgentLifecyclePresentation(entries);
let currentActivitySummary: AgentCompanionActivitySummary = deriveAgentCompanionActivitySummary(entries);
let seenActivityKeys = new Set<string>();
let pruneTimer: NodeJS.Timeout | null = null;

export function initializeAgentLifecycleController(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => pruneAgentLifecycleEntries(Date.now()), pruneIntervalMs);
  pruneTimer.unref?.();
  info("agent.lifecycle", "controller initialized", { staleAfterMs });
}

export function ingestAgentLifecycleEvent(event: AgentLifecycleEvent): AgentLifecyclePresentation {
  entries = applyAgentLifecycleEvent(entries, event);
  compactSeenActivityKeys();
  const next = deriveAgentLifecyclePresentation(entries, event);
  currentActivitySummary = deriveAgentCompanionActivitySummary(entries, 50, seenActivityKeys);
  const replayReady = event.state === "ready" && next.state === "ready";
  if (replayReady || presentationChanged(currentPresentation, next)) applyPresentation(next);
  else setPrimaryCompanionActivitySummary(currentActivitySummary, { wake: true });
  currentPresentation = next;
  debug("agent.lifecycle", "event accepted", { agent: event.agent, state: event.state, presentation: next.state, activeCount: next.activeCount });
  return next;
}

export function getAgentCompanionActivitySummary(): AgentCompanionActivitySummary {
  return structuredClone(currentActivitySummary);
}

export function replayAgentLifecyclePresentation(): AgentLifecyclePresentation {
  applyPresentation(currentPresentation);
  return currentPresentation;
}

export function markAgentCompanionActivitySeen(): AgentCompanionActivitySummary {
  for (const entry of entries.values()) {
    if (entry.state === "ready" || entry.state === "blocked") {
      seenActivityKeys.add(agentCompanionActivityKey({ provider: entry.agent, sessionId: entry.sessionId, occurredAt: entry.occurredAt }));
    }
  }
  currentActivitySummary = deriveAgentCompanionActivitySummary(entries, 50, seenActivityKeys);
  setPrimaryCompanionActivitySummary(currentActivitySummary);
  return getAgentCompanionActivitySummary();
}

export function dismissAgentCompanionActivity(provider: string, sessionId: string): AgentCompanionActivitySummary {
  entries.delete(`${provider}\u0000${sessionId}`);
  compactSeenActivityKeys();
  const next = deriveAgentLifecyclePresentation(entries);
  currentActivitySummary = deriveAgentCompanionActivitySummary(entries, 50, seenActivityKeys);
  applyPresentation(next);
  currentPresentation = next;
  return getAgentCompanionActivitySummary();
}

export function resetAgentLifecycleControllerForTests(): void {
  entries = new Map();
  seenActivityKeys = new Set();
  currentPresentation = deriveAgentLifecyclePresentation(entries);
  currentActivitySummary = deriveAgentCompanionActivitySummary(entries, 50, seenActivityKeys);
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
}

function pruneAgentLifecycleEntries(now: number): void {
  const nextEntries = pruneStaleAgentLifecycleEntries(entries, now, staleAfterMs);
  if (nextEntries.size === entries.size) return;
  entries = nextEntries;
  compactSeenActivityKeys();
  const next = deriveAgentLifecyclePresentation(entries);
  currentActivitySummary = deriveAgentCompanionActivitySummary(entries, 50, seenActivityKeys);
  if (presentationChanged(currentPresentation, next)) applyPresentation(next);
  else setPrimaryCompanionActivitySummary(currentActivitySummary);
  currentPresentation = next;
  debug("agent.lifecycle", "stale sessions pruned", { activeCount: next.activeCount, presentation: next.state });
}

function applyPresentation(presentation: AgentLifecyclePresentation): void {
  applyPrimaryCompanionLifecycle(currentActivitySummary, presentation.reaction, { sticky: presentation.sticky });
  publishPluginAgentActivity({ kind: "react", reaction: presentation.reaction ?? "idle", surface: "default" });
}

function compactSeenActivityKeys(): void {
  const currentKeys = new Set(
    [...entries.values()].map((entry) => agentCompanionActivityKey({ provider: entry.agent, sessionId: entry.sessionId, occurredAt: entry.occurredAt })),
  );
  seenActivityKeys = new Set([...seenActivityKeys].filter((key) => currentKeys.has(key)));
}

function presentationChanged(left: AgentLifecyclePresentation, right: AgentLifecyclePresentation): boolean {
  return left.state !== right.state || left.reaction !== right.reaction || left.sticky !== right.sticky || left.activeCount !== right.activeCount;
}
