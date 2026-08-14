export const openPetsIpcProtocol = "openpets-ipc";
export const openPetsIpcVersion = 1;
export const maxIpcMessageBytes = 16 * 1024;
export const connectTimeoutMs = 2_000;
export const responseTimeoutMs = 3_000;

export const allowedReactions = [
  "idle",
  "thinking",
  "working",
  "editing",
  "running",
  "testing",
  "waiting",
  "waving",
  "success",
  "error",
  "celebrating",
] as const;

export const allowedAgentLifecycleStates = ["working", "waiting", "ready", "blocked", "idle"] as const;
export const agentActivitySchemaVersion = 1;
export const allowedAgentCompanionCapabilities = ["observeLifecycle", "listActivity", "openTask", "stopTask", "respondToRequest", "sendMessage", "voice", "detailActivity"] as const;
export const allowedAgentCompanionRequestKinds = ["permission", "question", "review", "openLink", "stop", "continue"] as const;
export const allowedAgentCompanionRequestOptionIntents = ["allow", "deny", "runOnce", "apply", "answer", "review", "open", "stop", "continue"] as const;

export type OpenPetsReaction = typeof allowedReactions[number];
export type AgentLifecycleState = typeof allowedAgentLifecycleStates[number];
export type AgentCompanionCapability = typeof allowedAgentCompanionCapabilities[number];
export type AgentCompanionRequestKind = typeof allowedAgentCompanionRequestKinds[number];
export type AgentCompanionRequestOptionIntent = typeof allowedAgentCompanionRequestOptionIntents[number];
export interface AgentCompanionRequestOption { readonly id: string; readonly label: string; readonly intent: AgentCompanionRequestOptionIntent }
export type OpenPetsIpcMethod = "hello" | "status" | "pets.list" | "pets.install" | "lease.acquire" | "lease.heartbeat" | "lease.release" | "agent.activity" | "pet.react" | "pet.say" | "pet.showMedia" | "pets.install-local";

export interface OpenPetsIpcRequest {
  readonly id: string;
  readonly version: 1;
  readonly token: string;
  readonly method: OpenPetsIpcMethod;
  readonly params?: unknown;
}

export interface OpenPetsIpcOkResponse<T = unknown> {
  readonly id: string | null;
  readonly ok: true;
  readonly result: T;
}

export interface OpenPetsIpcErrorResponse {
  readonly id: string | null;
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type OpenPetsIpcResponse<T = unknown> = OpenPetsIpcOkResponse<T> | OpenPetsIpcErrorResponse;

export function parseIpcResponse<T = unknown>(value: unknown): OpenPetsIpcResponse<T> {
  if (!isRecord(value)) throw new OpenPetsClientError("invalid_response", "IPC response must be an object.");
  if (typeof value.id !== "string" && value.id !== null) throw new OpenPetsClientError("invalid_response", "IPC response id is invalid.");

  if (value.ok === true) {
    return { id: value.id, ok: true, result: value.result as T };
  }

  if (value.ok === false && isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") {
    return { id: value.id, ok: false, error: { code: value.error.code, message: value.error.message } };
  }

  throw new OpenPetsClientError("invalid_response", "IPC response shape is invalid.");
}

export function validateReaction(value: string): OpenPetsReaction {
  if (!allowedReactions.includes(value as OpenPetsReaction)) {
    throw new OpenPetsClientError("invalid_reaction", "Invalid OpenPets reaction.");
  }
  return value as OpenPetsReaction;
}

export function validateAgentLifecycleState(value: string): AgentLifecycleState {
  if (!allowedAgentLifecycleStates.includes(value as AgentLifecycleState)) {
    throw new OpenPetsClientError("invalid_agent_lifecycle_state", "Invalid agent lifecycle state.");
  }
  return value as AgentLifecycleState;
}

export function validateAgentCompanionCapabilities(value: readonly string[] | undefined): readonly AgentCompanionCapability[] {
  if (value === undefined) return ["observeLifecycle"];
  if (value.length > allowedAgentCompanionCapabilities.length) throw new OpenPetsClientError("invalid_params", "Too many Agent companion capabilities.");
  const capabilities: AgentCompanionCapability[] = [];
  for (const entry of value) {
    if (!allowedAgentCompanionCapabilities.includes(entry as AgentCompanionCapability)) {
      throw new OpenPetsClientError("invalid_params", "Invalid Agent companion capability.");
    }
    const capability = entry as AgentCompanionCapability;
    if (!capabilities.includes(capability)) capabilities.push(capability);
  }
  if (!capabilities.includes("observeLifecycle")) throw new OpenPetsClientError("invalid_params", "Agent lifecycle provider must declare observeLifecycle.");
  return capabilities;
}

export function validateAgentCompanionRequestOptions(value: unknown): readonly AgentCompanionRequestOption[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) throw new OpenPetsClientError("invalid_params", "Agent request options are invalid.");
  const options: AgentCompanionRequestOption[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.id) || ids.has(entry.id)) throw new OpenPetsClientError("invalid_params", "Agent request option id is invalid.");
    if (typeof entry.label !== "string" || entry.label.length < 1 || entry.label.length > 40 || /[\r\n\u0000-\u001f\u007f]/.test(entry.label)) throw new OpenPetsClientError("invalid_params", "Agent request option label is invalid.");
    if (typeof entry.intent !== "string" || !allowedAgentCompanionRequestOptionIntents.includes(entry.intent as AgentCompanionRequestOptionIntent)) throw new OpenPetsClientError("invalid_params", "Agent request option intent is invalid.");
    ids.add(entry.id);
    options.push({ id: entry.id, label: entry.label, intent: entry.intent as AgentCompanionRequestOptionIntent });
  }
  return options;
}

export class OpenPetsClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
