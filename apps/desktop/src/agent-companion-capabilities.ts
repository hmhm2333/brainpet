export const agentCompanionCapabilities = [
  "observeLifecycle",
  "listActivity",
  "openTask",
  "stopTask",
  "respondToRequest",
  "sendMessage",
  "voice",
  "detailActivity",
] as const;

export type AgentCompanionCapability = typeof agentCompanionCapabilities[number];

export const agentCompanionStatuses = ["working", "waiting", "review", "failed", "idle"] as const;
export type AgentCompanionStatus = typeof agentCompanionStatuses[number];

export const agentCompanionPromptActions = ["openTask", "stopTask", "respondToRequest", "sendMessage", "voice"] as const;
export type AgentCompanionPromptAction = typeof agentCompanionPromptActions[number];

export const agentCompanionRequestKinds = ["permission", "question", "review", "openLink", "stop", "continue"] as const;
export type AgentCompanionRequestKind = typeof agentCompanionRequestKinds[number];

export const agentCompanionRequestOptionIntents = ["allow", "deny", "runOnce", "apply", "answer", "review", "open", "stop", "continue"] as const;
export type AgentCompanionRequestOptionIntent = typeof agentCompanionRequestOptionIntents[number];

export interface AgentCompanionRequestOption {
  readonly id: string;
  /** Display-only text supplied by the registered provider adapter. */
  readonly label: string;
  readonly intent: AgentCompanionRequestOptionIntent;
}

export interface AgentCompanionRequestSummary {
  readonly kind: AgentCompanionRequestKind;
  readonly requestId?: string;
  readonly options?: readonly AgentCompanionRequestOption[];
}

export interface AgentCompanionActionDescriptor {
  readonly action: AgentCompanionPromptAction;
  readonly provider: string;
  readonly sessionId: string;
  readonly requestId?: string;
  readonly expiresAt: number;
  readonly nonce: string;
}

export interface AgentCompanionActionContext {
  readonly status: AgentCompanionStatus;
  readonly capabilities: ReadonlySet<AgentCompanionCapability>;
  readonly hasRequest: boolean;
}

/**
 * Builds the provider-backed actions that may be rendered for one activity.
 * Universal local controls (activity tray, hide, resize, and training) do not
 * belong here because they do not claim to control the Agent host.
 */
export function deriveAgentCompanionPromptActions(context: AgentCompanionActionContext): readonly AgentCompanionPromptAction[] {
  const actions: AgentCompanionPromptAction[] = [];
  const activeTask = context.status !== "idle";

  if (activeTask && context.capabilities.has("openTask")) actions.push("openTask");
  if (context.status === "working" && context.capabilities.has("stopTask")) actions.push("stopTask");
  if (context.status === "waiting" && context.hasRequest && context.capabilities.has("respondToRequest")) actions.push("respondToRequest");
  if (activeTask && context.capabilities.has("sendMessage")) actions.push("sendMessage");
  if (context.capabilities.has("voice")) actions.push("voice");

  return actions;
}

/** Strictly validates a provider registration boundary and removes duplicates. */
export function validateAgentCompanionCapabilities(value: unknown): readonly AgentCompanionCapability[] {
  if (!Array.isArray(value)) throw new TypeError("Agent companion capabilities must be an array.");
  const capabilities: AgentCompanionCapability[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !agentCompanionCapabilities.includes(entry as AgentCompanionCapability)) {
      throw new TypeError("Agent companion capability is invalid.");
    }
    const capability = entry as AgentCompanionCapability;
    if (!capabilities.includes(capability)) capabilities.push(capability);
  }
  return capabilities;
}

export function validateAgentCompanionActionDescriptor(value: unknown, now = Date.now()): AgentCompanionActionDescriptor {
  if (!isRecord(value) || typeof value.action !== "string" || !agentCompanionPromptActions.includes(value.action as AgentCompanionPromptAction)) throw new TypeError("Agent companion action is invalid.");
  if (typeof value.provider !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value.provider)) throw new TypeError("Agent companion action provider is invalid.");
  if (!isIdentifier(value.sessionId, 160) || value.requestId !== undefined && !isIdentifier(value.requestId, 160)) throw new TypeError("Agent companion action target is invalid.");
  if (typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 10 * 60_000) throw new TypeError("Agent companion action expiry is invalid.");
  if (typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value.nonce)) throw new TypeError("Agent companion action nonce is invalid.");
  return value as unknown as AgentCompanionActionDescriptor;
}

function isIdentifier(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength && !/[\x00-\x1F\x7F]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
