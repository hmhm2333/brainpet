import type { AgentCompanionActivityItem, AgentCompanionActivitySummary } from "./agent-companion-activity.js";
import type { AgentCompanionStatus } from "./agent-companion-capabilities.js";

export interface PrimaryCompanionActivityViewItem extends AgentCompanionActivityItem {
  readonly providerLabel: string;
  readonly ageLabel: string;
}

export interface PrimaryCompanionViewModel {
  readonly status: AgentCompanionStatus;
  readonly badgeCount: number;
  readonly unreadCount: number;
  readonly totalCount: number;
  readonly items: readonly PrimaryCompanionActivityViewItem[];
}

export function derivePrimaryCompanionView(
  summary: AgentCompanionActivitySummary,
  now = Date.now(),
  maximumVisibleItems = 5,
): PrimaryCompanionViewModel {
  const limit = Math.max(0, Math.min(5, Math.floor(maximumVisibleItems)));
  return {
    status: summary.status,
    badgeCount: Math.min(99, Math.max(summary.activeCount, summary.unreadCount, summary.totalCount)),
    unreadCount: summary.unreadCount,
    totalCount: summary.totalCount,
    items: summary.items.slice(0, limit).map((item) => ({
      ...item,
      providerLabel: formatPrimaryCompanionProvider(item.provider),
      ageLabel: formatPrimaryCompanionAge(item.occurredAt, now),
    })),
  };
}

export function formatPrimaryCompanionProvider(provider: string): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude" || provider === "claude-code") return "Claude";
  if (provider === "workbuddy") return "WorkBuddy";
  return provider.slice(0, 32);
}

export function formatPrimaryCompanionAge(occurredAt: number, now = Date.now()): string {
  const elapsedMs = Math.max(0, now - occurredAt);
  if (elapsedMs < 60_000) return "now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
