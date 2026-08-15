import { agentActivityPrivacyRejectedFields, agentActivitySchemaVersion, normalizedAgentLifecycleStates } from "./generated-contract.js";

export { agentActivityMethod, agentActivityOptionalFields, agentActivityPrivacyRejectedFields, agentActivityRequiredFields, agentActivitySchemaVersion, normalizedAgentLifecycleStates } from "./generated-contract.js";

export type HookSpeechCategory = "thinking" | "success" | "error" | "permission";
export type NormalizedAgentLifecycleState = typeof normalizedAgentLifecycleStates[number];
export type NormalizedAgentRequestKind = "permission" | "question" | "review" | "openLink" | "stop" | "continue";

export interface NormalizedAgentLifecycleEvent {
  readonly schemaVersion: typeof agentActivitySchemaVersion;
  readonly agent: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly state: NormalizedAgentLifecycleState;
  readonly occurredAt: number;
  readonly capabilities: readonly ["observeLifecycle"];
  readonly request?: { readonly kind: NormalizedAgentRequestKind };
}

/**
 * Shared privacy boundary for provider adapters. It accepts opaque identifiers
 * and state only; prompt, transcript, cwd and tool payloads have no slot in the
 * returned object.
 */
export function createNormalizedAgentLifecycleEvent(input: {
  readonly agent: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly state: NormalizedAgentLifecycleState;
  readonly occurredAt?: number;
  readonly requestKind?: NormalizedAgentRequestKind;
}): NormalizedAgentLifecycleEvent {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.agent)) throw new TypeError("Agent lifecycle provider is invalid.");
  if (!isOpaqueIdentifier(input.sessionId, 160) || input.turnId !== undefined && !isOpaqueIdentifier(input.turnId, 160)) throw new TypeError("Agent lifecycle identifier is invalid.");
  if (!normalizedAgentLifecycleStates.includes(input.state)) throw new TypeError("Agent lifecycle state is invalid.");
  const occurredAt = input.occurredAt ?? Date.now();
  if (!Number.isSafeInteger(occurredAt) || occurredAt <= 0) throw new TypeError("Agent lifecycle timestamp is invalid.");
  return {
    schemaVersion: agentActivitySchemaVersion,
    agent: input.agent,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    state: input.state,
    occurredAt,
    capabilities: ["observeLifecycle"],
    ...(input.requestKind ? { request: { kind: input.requestKind } } : {}),
  };
}

export function assertNoRejectedAgentActivityFields(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Agent lifecycle event must be an object.");
  for (const field of agentActivityPrivacyRejectedFields) {
    if (field in value) throw new TypeError(`Agent lifecycle event contains rejected field: ${field}`);
  }
}

export const hookSpeechPools: Record<HookSpeechCategory, readonly string[]> = {
  thinking: ["Thinking it through", "Let me check", "On it", "Working it out"],
  success: ["Done", "That worked", "All set", "Nice, finished"],
  error: ["Something failed", "Needs another look", "Hit a snag", "Not quite there"],
  permission: ["Approval needed"],
};

export function pickHookSpeech(category: HookSpeechCategory, random: () => number = Math.random): string {
  const pool = hookSpeechPools[category];
  return pool[Math.max(0, Math.min(pool.length - 1, Math.floor(random() * pool.length)))] ?? pool[0] ?? "Working";
}

export function validateHookSpeech(message: string): string {
  if (message.length < 1 || message.length > 140) throw new Error("Hook speech length is invalid.");
  if (/\r|\n/.test(message)) throw new Error("Hook speech must be single line.");
  if (/```|\b(function|const|let|var|class|import|export)\b|[{};]/.test(message)) throw new Error("Hook speech looks code-like.");
  if (/https?:\/\/|www\./i.test(message)) throw new Error("Hook speech must not contain URLs.");
  if (/(^|\s)(?:~|\.{1,2}|[A-Za-z]:)?[\\/][^\s]+/.test(message)) throw new Error("Hook speech must not contain paths.");
  if (/\b(api[_-]?key|secret|password|token)\s*[:=]/i.test(message)) throw new Error("Hook speech must not contain secrets.");
  return message;
}

function isOpaqueIdentifier(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength && !/[\x00-\x1F\x7F]/.test(value);
}
