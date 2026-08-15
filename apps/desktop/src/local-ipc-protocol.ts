import { randomUUID } from "node:crypto";
import { extname, isAbsolute } from "node:path";

import { agentActivityPrivacyRejectedFields, agentActivitySchemaVersion, normalizedAgentLifecycleStates } from "@open-pets/agent-events";

export const openPetsIpcProtocol = "openpets-ipc";
export const openPetsIpcVersion = 1;
export const maxIpcMessageBytes = 16 * 1024;
export const transientDisplayMs = 4_000;
export const maxMediaFileBytes = 10 * 1024 * 1024;
export const minMediaDurationMs = 1_000;
export const maxMediaDurationMs = 30_000;
export const defaultMediaDurationMs = 8_000;
export const allowedMediaExtensions = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;

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

export const allowedAgentLifecycleStates = normalizedAgentLifecycleStates;
export { agentActivitySchemaVersion };
export const allowedAgentCompanionCapabilities = ["observeLifecycle", "listActivity", "openTask", "stopTask", "respondToRequest", "sendMessage", "voice", "detailActivity"] as const;
export const allowedAgentCompanionRequestKinds = ["permission", "question", "review", "openLink", "stop", "continue"] as const;
export const allowedAgentCompanionRequestOptionIntents = ["allow", "deny", "runOnce", "apply", "answer", "review", "open", "stop", "continue"] as const;

export type OpenPetsReaction = typeof allowedReactions[number];
export type AgentLifecycleState = typeof allowedAgentLifecycleStates[number];
export type AgentCompanionCapability = typeof allowedAgentCompanionCapabilities[number];
export type AgentCompanionRequestKind = typeof allowedAgentCompanionRequestKinds[number];
export type AgentCompanionRequestOptionIntent = typeof allowedAgentCompanionRequestOptionIntents[number];
export interface AgentCompanionRequestOption { readonly id: string; readonly label: string; readonly intent: AgentCompanionRequestOptionIntent }
export interface AgentCompanionRequestSummary { readonly kind: AgentCompanionRequestKind; readonly requestId?: string; readonly options?: readonly AgentCompanionRequestOption[] }
export type OpenPetsIpcMethod = "hello" | "status" | "pets.list" | "pets.install" | "lease.acquire" | "lease.heartbeat" | "lease.release" | "agent.activity" | "pet.react" | "pet.say" | "pet.showMedia" | "pets.install-local";

export interface AgentLifecycleParams {
  readonly schemaVersion: 1;
  readonly agent: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly state: AgentLifecycleState;
  readonly occurredAt: number;
  readonly capabilities: readonly AgentCompanionCapability[];
  readonly request?: AgentCompanionRequestSummary;
}

export interface OpenPetsIpcRequest {
  readonly id: string;
  readonly version: number;
  readonly token: string;
  readonly method: OpenPetsIpcMethod;
  readonly params?: unknown;
}

export interface OpenPetsIpcResponse {
  readonly id: string | null;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export function createRequestId(): string {
  return randomUUID();
}

export function parseIpcRequest(raw: string, expectedToken: string): OpenPetsIpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new IpcProtocolError("invalid_request", "IPC request must be valid JSON.");
  }
  if (!isRecord(parsed)) throw new IpcProtocolError("invalid_request", "IPC request must be an object.");
  if (typeof parsed.id !== "string" || parsed.id.length < 1 || parsed.id.length > 120) throw new IpcProtocolError("invalid_request", "IPC request id is invalid.");
  if (parsed.version !== openPetsIpcVersion) throw new IpcProtocolError("invalid_version", "Unsupported IPC protocol version.");
  if (parsed.token !== expectedToken) throw new IpcProtocolError("invalid_token", "Invalid IPC token.");
  if (parsed.method !== "hello" && parsed.method !== "status" && parsed.method !== "pets.list" && parsed.method !== "pets.install" && parsed.method !== "lease.acquire" && parsed.method !== "lease.heartbeat" && parsed.method !== "lease.release" && parsed.method !== "agent.activity" && parsed.method !== "pet.react" && parsed.method !== "pet.say" && parsed.method !== "pet.showMedia" && parsed.method !== "pets.install-local") {
    throw new IpcProtocolError("unknown_method", "Unknown IPC method.");
  }

  return {
    id: parsed.id,
    version: parsed.version,
    token: parsed.token,
    method: parsed.method,
    params: parsed.params,
  };
}

export function validateAgentLifecycleParams(value: unknown): AgentLifecycleParams {
  if (!isRecord(value)) throw new IpcProtocolError("invalid_params", "Agent lifecycle payload must be an object.");
  for (const field of agentActivityPrivacyRejectedFields) {
    if (field in value) throw new IpcProtocolError("invalid_params", `Agent lifecycle payload contains rejected field: ${field}`);
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== agentActivitySchemaVersion) {
    throw new IpcProtocolError("invalid_params", "Agent activity schema version is invalid.");
  }
  const agent = validateLifecycleIdentifier(value.agent, "Agent", 32, /^[a-z0-9][a-z0-9-]*$/);
  const sessionId = validateLifecycleIdentifier(value.sessionId, "Session id", 160);
  const turnId = value.turnId === undefined ? undefined : validateLifecycleIdentifier(value.turnId, "Turn id", 160);
  if (typeof value.state !== "string" || !allowedAgentLifecycleStates.includes(value.state as AgentLifecycleState)) {
    throw new IpcProtocolError("invalid_params", "Agent lifecycle state is invalid.");
  }
  if (typeof value.occurredAt !== "number" || !Number.isSafeInteger(value.occurredAt) || value.occurredAt <= 0) {
    throw new IpcProtocolError("invalid_params", "Agent lifecycle timestamp is invalid.");
  }
  const capabilities = value.capabilities === undefined
    ? ["observeLifecycle"] as const
    : validateAgentCompanionCapabilities(value.capabilities);
  if (!capabilities.includes("observeLifecycle")) {
    throw new IpcProtocolError("invalid_params", "Agent lifecycle provider must declare observeLifecycle.");
  }
  const request = value.request === undefined ? undefined : validateAgentCompanionRequestSummary(value.request);
  if (request && value.state !== "waiting") throw new IpcProtocolError("invalid_params", "Agent request summaries require the waiting state.");
  return { schemaVersion: agentActivitySchemaVersion, agent, sessionId, ...(turnId ? { turnId } : {}), state: value.state as AgentLifecycleState, occurredAt: value.occurredAt, capabilities, ...(request ? { request } : {}) };
}

function validateAgentCompanionRequestSummary(value: unknown): AgentCompanionRequestSummary {
  if (!isRecord(value) || typeof value.kind !== "string" || !allowedAgentCompanionRequestKinds.includes(value.kind as AgentCompanionRequestKind)) throw new IpcProtocolError("invalid_params", "Agent request summary is invalid.");
  const requestId = value.requestId === undefined ? undefined : validateLifecycleIdentifier(value.requestId, "Request id", 160);
  const options = value.options === undefined ? undefined : validateAgentCompanionRequestOptions(value.options);
  return { kind: value.kind as AgentCompanionRequestKind, ...(requestId ? { requestId } : {}), ...(options ? { options } : {}) };
}

function validateAgentCompanionRequestOptions(value: unknown): readonly AgentCompanionRequestOption[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) throw new IpcProtocolError("invalid_params", "Agent request options are invalid.");
  const options: AgentCompanionRequestOption[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) throw new IpcProtocolError("invalid_params", "Agent request option is invalid.");
    const id = validateLifecycleIdentifier(entry.id, "Request option id", 64, /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    if (ids.has(id)) throw new IpcProtocolError("invalid_params", "Agent request option ids must be unique.");
    if (typeof entry.label !== "string" || entry.label.length < 1 || entry.label.length > 40 || /[\r\n\u0000-\u001f\u007f]/.test(entry.label)) throw new IpcProtocolError("invalid_params", "Agent request option label is invalid.");
    if (typeof entry.intent !== "string" || !allowedAgentCompanionRequestOptionIntents.includes(entry.intent as AgentCompanionRequestOptionIntent)) throw new IpcProtocolError("invalid_params", "Agent request option intent is invalid.");
    ids.add(id);
    options.push({ id, label: entry.label, intent: entry.intent as AgentCompanionRequestOptionIntent });
  }
  return options;
}

function validateAgentCompanionCapabilities(value: unknown): readonly AgentCompanionCapability[] {
  if (!Array.isArray(value) || value.length > allowedAgentCompanionCapabilities.length) {
    throw new IpcProtocolError("invalid_params", "Agent companion capabilities are invalid.");
  }
  const capabilities: AgentCompanionCapability[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !allowedAgentCompanionCapabilities.includes(entry as AgentCompanionCapability)) {
      throw new IpcProtocolError("invalid_params", "Agent companion capability is invalid.");
    }
    const capability = entry as AgentCompanionCapability;
    if (!capabilities.includes(capability)) capabilities.push(capability);
  }
  return capabilities;
}

function validateLifecycleIdentifier(value: unknown, label: string, maxLength: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /[\x00-\x1F\x7F]/.test(value) || pattern && !pattern.test(value)) {
    throw new IpcProtocolError("invalid_params", `${label} is invalid.`);
  }
  return value;
}

export function validateInstallPetId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) || value === "builtin") {
    throw new IpcProtocolError("invalid_params", "Invalid pet id.");
  }
  return value;
}

export function validateReaction(value: unknown): OpenPetsReaction {
  if (typeof value !== "string" || !allowedReactions.includes(value as OpenPetsReaction)) {
    throw new IpcProtocolError("invalid_params", "Invalid pet reaction.");
  }
  return value as OpenPetsReaction;
}

export function validateSayMessage(value: unknown): string {
  if (typeof value !== "string") throw new IpcProtocolError("invalid_params", "Message must be a string.");
  const message = value.trim();
  if (message.length < 1) throw new IpcProtocolError("invalid_params", "Message cannot be empty.");
  if (message.length > 140) throw new IpcProtocolError("invalid_params", "Message is too long.");
  if (/[\r\n]/.test(message)) throw new IpcProtocolError("invalid_params", "Message must be single-line.");
  if (/```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b/.test(message)) throw new IpcProtocolError("invalid_params", "Message looks like code.");
  if (/https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\/.test(message)) throw new IpcProtocolError("invalid_params", "Message contains a URL or path-like content.");
  if (/(api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]+PRIVATE KEY)/i.test(message)) throw new IpcProtocolError("invalid_params", "Message looks secret-like.");
  return message;
}

export function validateOptionalLeaseId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 120 || /[\0\r\n]/.test(value)) {
    throw new IpcProtocolError("invalid_params", "Invalid lease id.");
  }
  return value;
}

export function validateRequestedPetId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new IpcProtocolError("invalid_params", "Requested pet id must be a string.");
  const trimmed = value.trim();
  if (trimmed.length < 1) return undefined;
  if (Buffer.byteLength(trimmed, "utf8") > 128 || /[\x00-\x1F\x7F/\\]/.test(trimmed)) {
    throw new IpcProtocolError("invalid_params", "Requested pet id is outside CLI bounds.");
  }
  return trimmed;
}

/**
 * Validate the optional sessionNonce from a lease.acquire request.
 * The nonce is a UUID generated once per MCP process (not per-call) and used
 * alongside clientPid to prevent OS PID-reuse session collisions.
 * Accepts any non-empty string ≤128 chars with no control characters.
 */
export function validateSessionNonce(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined; // tolerate missing/malformed — degrade gracefully
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128 || /[\x00-\x1F\x7F]/.test(trimmed)) return undefined;
  return trimmed;
}

export function okResponse(id: string | null, result: unknown): OpenPetsIpcResponse {
  return { id, ok: true, result };
}

export function errorResponse(id: string | null, error: unknown): OpenPetsIpcResponse {
  if (error instanceof IpcProtocolError) {
    return { id, ok: false, error: { code: error.code, message: error.message } };
  }

  return {
    id,
    ok: false,
    error: {
      code: "internal_error",
      message: error instanceof Error ? error.message : "IPC request failed.",
    },
  };
}

export class IpcProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateInstallLocalPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new IpcProtocolError("invalid_params", "Path must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed.length < 1) {
    throw new IpcProtocolError("invalid_params", "Path cannot be empty.");
  }
  if (Buffer.byteLength(trimmed, "utf8") > 2048) {
    throw new IpcProtocolError("invalid_params", "Path is too long.");
  }
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new IpcProtocolError("invalid_params", "Path contains invalid control characters.");
  }
  if (!isAbsolute(trimmed)) {
    throw new IpcProtocolError("invalid_params", "Path must be absolute.");
  }
  return trimmed;
}

export function validateMediaPath(value: unknown): string {
  const path = validateInstallLocalPath(value);
  const extension = extname(path).toLowerCase();
  if (!allowedMediaExtensions.includes(extension as typeof allowedMediaExtensions[number])) {
    throw new IpcProtocolError("invalid_params", `Media path extension must be one of: ${allowedMediaExtensions.join(", ")}.`);
  }
  return path;
}

/**
 * Schemes that must never reach shell.openExternal from IPC input: local
 * content and script execution (file/javascript/data/...), plain http (no
 * downgrade from https), and Windows shell handlers with side effects.
 * Everything else — https plus custom registered app protocols (the point of
 * this field: hand the click back to the tool that sent the media) — is
 * allowed; an unregistered custom scheme is a no-op at the OS level.
 */
const blockedClickUrlProtocols = new Set(["http:", "file:", "javascript:", "data:", "vbscript:", "blob:", "about:", "chrome:", "ms-appx:", "ms-appx-web:", "shell:", "search-ms:", "search:", "res:"]);

export function validateMediaClickUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new IpcProtocolError("invalid_params", "Click URL must be a string.");
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 2048 || /[\x00-\x1F\x7F\s]/.test(trimmed)) {
    throw new IpcProtocolError("invalid_params", "Click URL is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new IpcProtocolError("invalid_params", "Click URL must be an absolute URL.");
  }
  if (blockedClickUrlProtocols.has(parsed.protocol.toLowerCase())) {
    throw new IpcProtocolError("invalid_params", "Click URL scheme is not allowed.");
  }
  return trimmed;
}

export function validateMediaDurationMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minMediaDurationMs || value > maxMediaDurationMs) {
    throw new IpcProtocolError("invalid_params", `Media duration must be a number between ${minMediaDurationMs} and ${maxMediaDurationMs} milliseconds.`);
  }
  return Math.round(value);
}

export function validateInstallLocalKind(value: unknown): "zip" | "folder" {
  if (value !== "zip" && value !== "folder") {
    throw new IpcProtocolError("invalid_params", "Local install kind must be zip or folder.");
  }
  return value;
}
