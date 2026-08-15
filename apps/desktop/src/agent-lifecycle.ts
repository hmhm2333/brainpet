import { allowedAgentLifecycleStates, type OpenPetsReaction } from "./local-ipc-protocol.js";
import type { AgentCompanionCapability } from "./agent-companion-capabilities.js";
import type { AgentCompanionRequestSummary } from "./agent-companion-capabilities.js";

export const agentLifecycleStates = allowedAgentLifecycleStates;
export type AgentLifecycleState = typeof agentLifecycleStates[number];

export interface AgentLifecycleEvent {
  readonly schemaVersion: 1;
  readonly agent: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly state: AgentLifecycleState;
  readonly occurredAt: number;
  readonly capabilities: readonly AgentCompanionCapability[];
  readonly request?: AgentCompanionRequestSummary;
}

export interface AgentLifecycleEntry extends AgentLifecycleEvent {}

export interface AgentLifecyclePresentation {
  readonly state: AgentLifecycleState;
  readonly reaction: OpenPetsReaction | null;
  readonly sticky: boolean;
  readonly activeCount: number;
}

const sameTurnStateRank: Readonly<Record<AgentLifecycleState, number>> = {
  idle: 5,
  ready: 4,
  blocked: 3,
  waiting: 2,
  working: 1,
};

export function applyAgentLifecycleEvent(
  entries: ReadonlyMap<string, AgentLifecycleEntry>,
  event: AgentLifecycleEvent,
): Map<string, AgentLifecycleEntry> {
  const next = new Map(entries);
  const key = agentLifecycleKey(event.agent, event.sessionId);
  const existing = next.get(key);
  if (existing && isLifecycleEventStale(existing, event)) return next;
  if (event.state === "idle") next.delete(key);
  else next.set(key, event);
  return next;
}

export function pruneStaleAgentLifecycleEntries(
  entries: ReadonlyMap<string, AgentLifecycleEntry>,
  now: number,
  staleAfterMs: number,
): Map<string, AgentLifecycleEntry> {
  const next = new Map(entries);
  for (const [key, entry] of next) {
    if (now - entry.occurredAt > staleAfterMs) next.delete(key);
  }
  return next;
}

export function deriveAgentLifecyclePresentation(
  entries: ReadonlyMap<string, AgentLifecycleEntry>,
  latestEvent?: AgentLifecycleEvent,
): AgentLifecyclePresentation {
  let waitingCount = 0;
  let blockedCount = 0;
  let workingCount = 0;
  for (const entry of entries.values()) {
    if (entry.state === "waiting") waitingCount += 1;
    else if (entry.state === "blocked") blockedCount += 1;
    else if (entry.state === "working") workingCount += 1;
  }
  const activeCount = waitingCount + blockedCount + workingCount;
  if (waitingCount > 0) return { state: "waiting", reaction: "waiting", sticky: true, activeCount };
  if (blockedCount > 0) return { state: "blocked", reaction: "error", sticky: true, activeCount };
  if (workingCount > 0) return { state: "working", reaction: "working", sticky: true, activeCount };
  if (latestEvent?.state === "ready") return { state: "ready", reaction: "success", sticky: false, activeCount: 0 };
  return { state: "idle", reaction: null, sticky: false, activeCount: 0 };
}

export function agentLifecycleKey(agent: string, sessionId: string): string {
  return `${agent}\u0000${sessionId}`;
}

function isLifecycleEventStale(existing: AgentLifecycleEntry, next: AgentLifecycleEvent): boolean {
  if (existing.state === "ready" && existing.turnId !== undefined && next.turnId === existing.turnId && next.state !== "ready") return true;
  if (next.occurredAt !== existing.occurredAt) return next.occurredAt < existing.occurredAt;
  if (next.turnId !== existing.turnId) return false;
  return sameTurnStateRank[next.state] < sameTurnStateRank[existing.state];
}
