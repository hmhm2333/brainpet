import type { AgentCompanionStatus } from "./agent-companion-capabilities.js";
import type { AgentCompanionCapability, AgentCompanionRequestSummary } from "./agent-companion-capabilities.js";
import type { AgentLifecycleEntry, AgentLifecycleState } from "./agent-lifecycle.js";

export interface AgentCompanionActivityItem {
  readonly provider: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly status: Exclude<AgentCompanionStatus, "idle">;
  readonly occurredAt: number;
  readonly unread: boolean;
  readonly capabilities: readonly AgentCompanionCapability[];
  readonly request?: AgentCompanionRequestSummary;
}

export interface AgentCompanionActivitySummary {
  readonly status: AgentCompanionStatus;
  readonly activeCount: number;
  readonly unreadCount: number;
  readonly totalCount: number;
  readonly items: readonly AgentCompanionActivityItem[];
}

const statusPriority: Readonly<Record<AgentCompanionStatus, number>> = {
  waiting: 5,
  failed: 4,
  working: 3,
  review: 2,
  idle: 1,
};

/**
 * Produces the privacy-minimal model consumed by the Primary Companion UI.
 * It intentionally carries no task title, prompt, transcript, path, command,
 * or tool payload.
 */
export function deriveAgentCompanionActivitySummary(
  entries: ReadonlyMap<string, AgentLifecycleEntry>,
  maximumItems = 50,
  seenActivityKeys: ReadonlySet<string> = new Set(),
): AgentCompanionActivitySummary {
  const limit = Math.max(0, Math.min(50, Math.floor(maximumItems)));
  const allItems = [...entries.values()]
    .filter((entry) => entry.state !== "idle")
    .map((entry) => toActivityItem(entry, seenActivityKeys))
    .sort((left, right) => right.occurredAt - left.occurredAt || left.provider.localeCompare(right.provider) || left.sessionId.localeCompare(right.sessionId));
  const items = allItems.slice(0, limit);
  const activeCount = allItems.filter((item) => item.status === "working" || item.status === "waiting").length;
  const unreadCount = allItems.filter((item) => item.unread).length;
  const status = allItems.reduce<AgentCompanionStatus>(
    (current, item) => statusPriority[item.status] > statusPriority[current] ? item.status : current,
    "idle",
  );

  return { status, activeCount, unreadCount, totalCount: allItems.length, items };
}

export function agentCompanionActivityKey(item: Pick<AgentCompanionActivityItem, "provider" | "sessionId" | "occurredAt">): string {
  return `${item.provider}\u0000${item.sessionId}\u0000${item.occurredAt}`;
}

export function mapAgentLifecycleToCompanionStatus(state: AgentLifecycleState): AgentCompanionStatus {
  if (state === "ready") return "review";
  if (state === "blocked") return "failed";
  return state;
}

function toActivityItem(entry: AgentLifecycleEntry, seenActivityKeys: ReadonlySet<string>): AgentCompanionActivityItem {
  const status = mapAgentLifecycleToCompanionStatus(entry.state);
  if (status === "idle") throw new TypeError("Idle lifecycle entries cannot become companion activity items.");
  const identity = { provider: entry.agent, sessionId: entry.sessionId, occurredAt: entry.occurredAt };
  return {
    ...identity,
    ...(entry.turnId ? { turnId: entry.turnId } : {}),
    status,
    occurredAt: entry.occurredAt,
    unread: (status === "review" || status === "failed") && !seenActivityKeys.has(agentCompanionActivityKey(identity)),
    capabilities: entry.capabilities,
    ...(entry.request ? { request: entry.request } : {}),
  };
}
