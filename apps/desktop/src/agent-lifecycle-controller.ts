import { applyExternalPetLifecycleReaction } from "./default-pet-controller.js";
import { debug, info } from "./logger.js";
import { publishPluginAgentActivity } from "./plugin-events-source.js";
import { applyAgentLifecycleEvent, deriveAgentLifecyclePresentation, pruneStaleAgentLifecycleEntries, type AgentLifecycleEntry, type AgentLifecycleEvent, type AgentLifecyclePresentation } from "./agent-lifecycle.js";
import { deriveAgentCompanionActivitySummary, type AgentCompanionActivitySummary } from "./agent-companion-activity.js";

const staleAfterMs = 30 * 60_000;
const pruneIntervalMs = 60_000;

let entries = new Map<string, AgentLifecycleEntry>();
let currentPresentation: AgentLifecyclePresentation = deriveAgentLifecyclePresentation(entries);
let currentActivitySummary: AgentCompanionActivitySummary = deriveAgentCompanionActivitySummary(entries);
let pruneTimer: NodeJS.Timeout | null = null;

export function initializeAgentLifecycleController(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => pruneAgentLifecycleEntries(Date.now()), pruneIntervalMs);
  pruneTimer.unref?.();
  info("agent.lifecycle", "controller initialized", { staleAfterMs });
}

export function ingestAgentLifecycleEvent(event: AgentLifecycleEvent): AgentLifecyclePresentation {
  entries = applyAgentLifecycleEvent(entries, event);
  const next = deriveAgentLifecyclePresentation(entries, event);
  currentActivitySummary = deriveAgentCompanionActivitySummary(entries);
  const replayReady = event.state === "ready" && next.state === "ready";
  if (replayReady || presentationChanged(currentPresentation, next)) applyPresentation(next);
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

export function resetAgentLifecycleControllerForTests(): void {
  entries = new Map();
  currentPresentation = deriveAgentLifecyclePresentation(entries);
  currentActivitySummary = deriveAgentCompanionActivitySummary(entries);
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
}

function pruneAgentLifecycleEntries(now: number): void {
  const nextEntries = pruneStaleAgentLifecycleEntries(entries, now, staleAfterMs);
  if (nextEntries.size === entries.size) return;
  entries = nextEntries;
  const next = deriveAgentLifecyclePresentation(entries);
  currentActivitySummary = deriveAgentCompanionActivitySummary(entries);
  if (presentationChanged(currentPresentation, next)) applyPresentation(next);
  currentPresentation = next;
  debug("agent.lifecycle", "stale sessions pruned", { activeCount: next.activeCount, presentation: next.state });
}

function applyPresentation(presentation: AgentLifecyclePresentation): void {
  applyExternalPetLifecycleReaction(presentation.reaction, { sticky: presentation.sticky });
  publishPluginAgentActivity({ kind: "react", reaction: presentation.reaction ?? "idle", surface: "default" });
}

function presentationChanged(left: AgentLifecyclePresentation, right: AgentLifecyclePresentation): boolean {
  return left.state !== right.state || left.reaction !== right.reaction || left.sticky !== right.sticky || left.activeCount !== right.activeCount;
}
