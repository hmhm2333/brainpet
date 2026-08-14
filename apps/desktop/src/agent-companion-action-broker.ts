import { randomUUID } from "node:crypto";

import type { AgentCompanionActivityItem, AgentCompanionActivitySummary } from "./agent-companion-activity.js";
import {
  deriveAgentCompanionPromptActions,
  validateAgentCompanionActionDescriptor,
  type AgentCompanionActionDescriptor,
  type AgentCompanionPromptAction,
  type AgentCompanionRequestKind,
  type AgentCompanionRequestOption,
} from "./agent-companion-capabilities.js";

export interface AgentCompanionActionInvocation {
  readonly descriptor: AgentCompanionActionDescriptor;
  readonly optionId?: string;
  readonly message?: string;
}

export type AgentCompanionActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error?: string };

export interface AgentCompanionProviderAdapter {
  readonly provider: string;
  readonly capabilities: readonly AgentCompanionPromptAction[];
  execute(invocation: AgentCompanionActionInvocation): Promise<AgentCompanionActionResult>;
}

export interface PrimaryCompanionActionControl {
  readonly id: string;
  readonly action: AgentCompanionPromptAction;
  readonly label?: string;
  readonly intent?: AgentCompanionRequestOption["intent"];
  readonly requiresMessage?: boolean;
  readonly disabled: boolean;
}

export interface PrimaryCompanionActionPrompt {
  readonly token: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly requestKind?: AgentCompanionRequestKind;
  readonly state: "ready" | "pending" | "error" | "fallback";
  readonly controls: readonly PrimaryCompanionActionControl[];
  readonly error?: string;
}

export type AgentCompanionActionExecutionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "invalid" | "expired" | "duplicate" | "unsupported" | "failed"; readonly error: string };

interface RegisteredProvider {
  readonly adapter: AgentCompanionProviderAdapter;
  readonly registrationId: string;
  readonly capabilities: ReadonlySet<AgentCompanionPromptAction>;
}

interface BrokerControl extends PrimaryCompanionActionControl {
  readonly descriptor: AgentCompanionActionDescriptor;
  readonly optionId?: string;
}

interface PromptRecord {
  readonly identity: string;
  readonly token: string;
  readonly provider: RegisteredProvider;
  readonly item: AgentCompanionActivityItem;
  readonly expiresAt: number;
  readonly controls: readonly BrokerControl[];
  state: "ready" | "pending" | "error";
  error?: string;
}

const promptLifetimeMs = 5 * 60_000;
const maximumMessageLength = 280;

/**
 * Host-owned broker for every Agent side effect exposed on the pet.
 * Lifecycle payloads may describe capabilities, but they can never execute an
 * action until an in-process provider adapter has registered the same ability.
 */
export class AgentCompanionActionBroker {
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly records = new Map<string, PromptRecord>();
  private readonly tokensByIdentity = new Map<string, string>();
  private readonly consumed = new Set<string>();
  private readonly listeners = new Set<() => void>();

  registerProvider(adapter: AgentCompanionProviderAdapter): () => void {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(adapter.provider)) throw new TypeError("Agent companion provider is invalid.");
    if (!Array.isArray(adapter.capabilities) || typeof adapter.execute !== "function") throw new TypeError("Agent companion provider adapter is invalid.");
    const capabilities = new Set<AgentCompanionPromptAction>();
    for (const capability of adapter.capabilities) {
      if (!isPromptAction(capability)) throw new TypeError("Agent companion provider action is invalid.");
      capabilities.add(capability);
    }
    const provider: RegisteredProvider = { adapter, registrationId: randomUUID(), capabilities };
    this.providers.set(adapter.provider, provider);
    this.dropProviderRecords(adapter.provider);
    this.notify();
    return () => {
      if (this.providers.get(adapter.provider)?.registrationId !== provider.registrationId) return;
      this.providers.delete(adapter.provider);
      this.dropProviderRecords(adapter.provider);
      this.notify();
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  derivePrompt(summary: AgentCompanionActivitySummary | null, now = Date.now()): PrimaryCompanionActionPrompt | null {
    this.prune(summary, now);
    if (!summary || summary.totalCount === 0) return null;
    const item = summary.items.find((candidate) => candidate.status === "waiting" && candidate.request)
      ?? summary.items.find((candidate) => {
        const provider = this.providers.get(candidate.provider);
        return provider ? this.getRegisteredActions(candidate, provider).some((action) => action !== "voice") : false;
      })
      ?? summary.items.find((candidate) => candidate.status === "waiting" || candidate.status === "failed" || candidate.status === "review");
    if (!item) return null;
    const identity = getPromptIdentity(item);
    if (this.consumed.has(identity)) return null;

    const provider = this.providers.get(item.provider);
    const actions = provider ? this.getRegisteredActions(item, provider) : [];
    if (!provider || actions.length === 0 || item.request && actions.includes("respondToRequest") && (!item.request.requestId || !item.request.options?.length)) {
      return {
        token: `fallback:${identity}`,
        provider: item.provider,
        sessionId: item.sessionId,
        ...(item.request ? { requestKind: item.request.kind } : {}),
        state: "fallback",
        controls: [],
      };
    }

    const existingToken = this.tokensByIdentity.get(identity);
    const existing = existingToken ? this.records.get(existingToken) : undefined;
    if (existing && existing.provider.registrationId === provider.registrationId && existing.expiresAt > now) return this.toPrompt(existing);

    const expiresAt = Math.min(now + promptLifetimeMs, item.occurredAt + 10 * 60_000);
    if (expiresAt <= now) return this.fallbackPrompt(item, identity);
    const token = randomUUID();
    const controls = this.createControls(item, provider, actions, expiresAt, now);
    if (controls.length === 0) return this.fallbackPrompt(item, identity);
    const record: PromptRecord = { identity, token, provider, item, expiresAt, controls, state: "ready" };
    this.records.set(token, record);
    this.tokensByIdentity.set(identity, token);
    return this.toPrompt(record);
  }

  async execute(token: string, controlId: string, values: { readonly message?: unknown } = {}, now = Date.now()): Promise<AgentCompanionActionExecutionResult> {
    const record = this.records.get(token);
    const control = record?.controls.find((candidate) => candidate.id === controlId);
    if (!record || !control) return failure("invalid", "This action is no longer available.");
    if (record.state === "pending") return failure("duplicate", "This action is already being submitted.");
    if (record.expiresAt <= now) {
      this.deleteRecord(record);
      this.notify();
      return failure("expired", "This action has expired.");
    }
    if (this.providers.get(record.item.provider)?.registrationId !== record.provider.registrationId) {
      this.deleteRecord(record);
      this.notify();
      return failure("unsupported", "Return to the Agent to continue.");
    }

    let message: string | undefined;
    if (control.requiresMessage) {
      message = validateMessage(values.message);
      if (!message) return failure("invalid", "Enter a short message first.");
    }
    try {
      validateAgentCompanionActionDescriptor(control.descriptor, now);
    } catch {
      this.deleteRecord(record);
      this.notify();
      return failure("expired", "This action has expired.");
    }

    record.state = "pending";
    record.error = undefined;
    this.notify();
    try {
      const result = await record.provider.adapter.execute({
        descriptor: control.descriptor,
        ...(control.optionId ? { optionId: control.optionId } : {}),
        ...(message ? { message } : {}),
      });
      if (!result.ok) {
        record.state = "error";
        record.error = sanitizeError(result.error);
        this.notify();
        return failure("failed", record.error);
      }
      this.consumed.add(record.identity);
      this.deleteRecord(record);
      this.notify();
      return { ok: true };
    } catch (error) {
      record.state = "error";
      record.error = sanitizeError(error instanceof Error ? error.message : undefined);
      this.notify();
      return failure("failed", record.error);
    }
  }

  resetForTests(): void {
    this.providers.clear();
    this.records.clear();
    this.tokensByIdentity.clear();
    this.consumed.clear();
    this.listeners.clear();
  }

  private getRegisteredActions(item: AgentCompanionActivityItem, provider: RegisteredProvider): readonly AgentCompanionPromptAction[] {
    const declared = new Set(item.capabilities);
    return deriveAgentCompanionPromptActions({ status: item.status, capabilities: declared, hasRequest: Boolean(item.request) })
      .filter((action) => provider.capabilities.has(action));
  }

  private createControls(item: AgentCompanionActivityItem, provider: RegisteredProvider, actions: readonly AgentCompanionPromptAction[], expiresAt: number, now: number): readonly BrokerControl[] {
    const controls: BrokerControl[] = [];
    for (const action of actions) {
      if (action === "voice") continue;
      if (action === "respondToRequest") {
        for (const option of item.request?.options ?? []) controls.push(this.createControl(item, action, provider, expiresAt, now, `response:${option.id}`, option));
        continue;
      }
      controls.push(this.createControl(item, action, provider, expiresAt, now, action));
    }
    return controls;
  }

  private createControl(item: AgentCompanionActivityItem, action: AgentCompanionPromptAction, provider: RegisteredProvider, expiresAt: number, now: number, id: string, option?: AgentCompanionRequestOption): BrokerControl {
    const descriptor = validateAgentCompanionActionDescriptor({
      action,
      provider: provider.adapter.provider,
      sessionId: item.sessionId,
      ...(item.request?.requestId ? { requestId: item.request.requestId } : {}),
      expiresAt,
      nonce: randomUUID().replaceAll("-", ""),
    }, now);
    return {
      id,
      action,
      ...(option ? { label: option.label, intent: option.intent, optionId: option.id } : {}),
      ...(action === "sendMessage" ? { requiresMessage: true } : {}),
      disabled: false,
      descriptor,
    };
  }

  private fallbackPrompt(item: AgentCompanionActivityItem, identity: string): PrimaryCompanionActionPrompt {
    return { token: `fallback:${identity}`, provider: item.provider, sessionId: item.sessionId, ...(item.request ? { requestKind: item.request.kind } : {}), state: "fallback", controls: [] };
  }

  private toPrompt(record: PromptRecord): PrimaryCompanionActionPrompt {
    return {
      token: record.token,
      provider: record.item.provider,
      sessionId: record.item.sessionId,
      ...(record.item.request ? { requestKind: record.item.request.kind } : {}),
      state: record.state,
      controls: record.controls.map(({ descriptor: _descriptor, optionId: _optionId, ...control }) => ({ ...control, disabled: record.state === "pending" })),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  private prune(summary: AgentCompanionActivitySummary | null, now: number): void {
    const identities = new Set(summary?.items.map(getPromptIdentity) ?? []);
    for (const record of this.records.values()) {
      if (!identities.has(record.identity) || record.expiresAt <= now) this.deleteRecord(record);
    }
    for (const identity of this.consumed) if (!identities.has(identity)) this.consumed.delete(identity);
  }

  private dropProviderRecords(provider: string): void {
    for (const record of this.records.values()) if (record.item.provider === provider) this.deleteRecord(record);
  }

  private deleteRecord(record: PromptRecord): void {
    this.records.delete(record.token);
    if (this.tokensByIdentity.get(record.identity) === record.token) this.tokensByIdentity.delete(record.identity);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* UI refresh failures must not alter action results. */ }
    }
  }
}

export const primaryCompanionActionBroker = new AgentCompanionActionBroker();

function getPromptIdentity(item: AgentCompanionActivityItem): string {
  return `${item.provider}\u0000${item.sessionId}\u0000${item.occurredAt}\u0000${item.request?.requestId ?? ""}`;
}

function isPromptAction(value: unknown): value is AgentCompanionPromptAction {
  return value === "openTask" || value === "stopTask" || value === "respondToRequest" || value === "sendMessage" || value === "voice";
}

function validateMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const message = value.trim();
  if (!message || message.length > maximumMessageLength || /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) return undefined;
  return message;
}

function sanitizeError(value: string | undefined): string {
  const clean = (value ?? "Provider action failed.").replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (clean || "Provider action failed.").slice(0, 96);
}

function failure(code: Exclude<AgentCompanionActionExecutionResult, { ok: true }>["code"], error: string): AgentCompanionActionExecutionResult {
  return { ok: false, code, error };
}
