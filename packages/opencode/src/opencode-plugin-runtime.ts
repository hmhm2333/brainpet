import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { createOpenPetsClient, type OpenPetsClient, type OpenPetsReaction, type TargetProduct } from "@open-pets/client";
import { createNormalizedAgentLifecycleEvent, type HookSpeechCategory, type NormalizedAgentLifecycleEvent } from "@open-pets/agent-events";
import { createInstallerPlan, defineAdapterDescriptor, type InstallerPlan, type TargetProfile } from "@open-pets/adapter-core";

import { validateOpenPetsPetArg } from "./opencode-previews.js";

export interface OpenCodePluginOptions {
  readonly product?: TargetProduct;
  readonly pet?: string;
  readonly debug?: boolean;
  /** @deprecated Retained for config compatibility; automatic lifecycle no longer emits reactions. */
  readonly excludeReactions?: readonly OpenPetsReaction[];
}

export interface OpenCodePluginRuntimeOptions extends OpenCodePluginOptions {
  readonly clientFactory?: () => OpenPetsClient;
  readonly schedule?: (work: () => Promise<void>) => void;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly throttlePath?: string;
  readonly debugLog?: (message: string) => void;
}

export const openCodeAdapterDescriptor = defineAdapterDescriptor({
  id: "opencode",
  displayName: "OpenCode",
  supportedProducts: ["brainpet", "openpets"],
  automaticLifecycle: true,
  lifecycleMethod: "agent.activity",
  installerKind: "opencode-plugin",
  capabilities: { lifecycle: "implemented", taskNavigation: "unavailable", requestActions: "unavailable", message: "unavailable", voice: "unavailable" },
});

export function createOpenCodeInstallerPlan(target: TargetProduct | TargetProfile, scope: "global" | "project", mode: InstallerPlan["mode"] = "install"): InstallerPlan {
  return createInstallerPlan({ providerId: openCodeAdapterDescriptor.id, installerKind: openCodeAdapterDescriptor.installerKind, target, scope, mode });
}

export interface OpenCodePluginDecision {
  readonly reaction?: OpenPetsReaction;
  readonly speechCategory?: HookSpeechCategory;
}

export type OpenCodeHooks = {
  readonly event: (input: { readonly event: unknown }) => void;
  readonly "chat.message": (input: unknown, output: unknown) => void;
  readonly "tool.execute.before": (input: { readonly tool?: string; readonly sessionID?: string; readonly sessionId?: string }, output: { readonly args?: unknown }) => void;
  readonly "tool.execute.after": (input: { readonly tool?: string }, output: unknown) => void;
};

export function isReactionExcluded(reaction: OpenPetsReaction, excludedSet: ReadonlySet<string>): boolean {
  return excludedSet.has(reaction);
}

export function createOpenPetsOpenCodeHooks(options: OpenCodePluginRuntimeOptions = {}): OpenCodeHooks {
  if (options.pet !== undefined) validateOpenPetsPetArg(options.pet);
  const clientFactory = options.clientFactory ?? (() => {
    if (!options.product) throw new Error("OpenCode plugin requires an explicit brainpet or openpets product target.");
    return createOpenPetsClient({ target: options.product, connectTimeoutMs: 500, responseTimeoutMs: 500 });
  });
  const schedule = options.schedule ?? defaultSchedule;
  const debug = options.debug === true || process.env.OPENPETS_DEBUG === "1";
  const debugLog = options.debugLog ?? ((message) => { if (debug) process.stderr.write(`${message}\n`); });
  let client: OpenPetsClient | undefined;
  let scheduledTail: Promise<void> | undefined;

  const run = (lifecycle?: NormalizedAgentLifecycleEvent | null): void => {
    if (!lifecycle) return;
    try {
      schedule(async () => {
        const work = async () => {
          try {
            client ??= clientFactory();
            await client.reportAgentActivity(lifecycle);
          } catch (error) {
            debugLog(`OpenPets OpenCode lifecycle ignored error: ${sanitizeDebugError(error)}`);
          }
        };
        const current = scheduledTail ? scheduledTail.then(work) : work();
        scheduledTail = current.then(() => undefined, () => undefined);
        await current;
      });
    } catch (error) {
      debugLog(`OpenPets OpenCode plugin scheduling ignored error: ${sanitizeDebugError(error)}`);
    }
  };

  return {
    event(input) {
      try {
        run(mapOpenCodeLifecycleEvent(input.event, options.now?.() ?? Date.now()));
      } catch (error) {
        debugLog(`OpenPets OpenCode event ignored error: ${sanitizeDebugError(error)}`);
      }
    },
    "chat.message"(input) {
      run(mapOpenCodeSyntheticLifecycle(input, "working", options.now?.() ?? Date.now()));
    },
    "tool.execute.before"(input, output) {
      const tool = typeof input.tool === "string" ? input.tool : "";
      if (shouldIgnoreOpenPetsTool(tool)) return;
      run(mapOpenCodeSyntheticLifecycle(input, "working", options.now?.() ?? Date.now()));
    },
    "tool.execute.after"() {
      // Intentionally quiet for now; session.error/session.status events provide less noisy completion signals.
    },
  };
}

export function classifyOpenCodeToolReaction(toolName: string, args?: unknown): OpenPetsReaction | undefined {
  const normalized = toolName.toLowerCase();
  if (/edit|write|patch|apply_patch/.test(normalized)) return "editing";
  if (/bash|shell|terminal/.test(normalized)) return isTestLikeToolArgs(args) ? "testing" : undefined;
  return undefined;
}

export function classifyOpenCodeBusEvent(event: unknown): OpenCodePluginDecision | undefined {
  const type = getEventType(event);
  if (type === "permission.asked") return shouldIgnoreOpenPetsTool(getEventPermission(event) ?? "") ? undefined : { reaction: "waiting", speechCategory: "permission" };
  if (type === "session.error") return { reaction: "error", speechCategory: "error" };
  if (type === "session.status" && getEventStatusType(event) === "idle") return { reaction: "success" };
  return undefined;
}

export function mapOpenCodeLifecycleEvent(event: unknown, occurredAt = Date.now()): NormalizedAgentLifecycleEvent | null {
  const type = getEventType(event);
  const sessionId = getEventSessionId(event);
  if (!type || !sessionId) return null;
  const status = getEventStatusType(event);
  const state = type === "permission.asked" || type === "question.asked" ? "waiting"
    : type === "permission.replied" || type === "permission.rejected" || type === "question.replied" || type === "question.rejected" ? "working"
      : type === "session.error" ? "blocked"
        : type === "session.deleted" ? "idle"
          : type === "session.idle" || type === "session.status" && status === "idle" ? "ready"
            : type === "session.status" && (status === "busy" || status === "active" || status === "retry") ? "working"
              : undefined;
  if (!state) return null;
  return createNormalizedAgentLifecycleEvent({
    agent: "opencode",
    sessionId,
    state,
    occurredAt,
    ...(type === "permission.asked" ? { requestKind: "permission" as const } : {}),
    ...(type === "question.asked" ? { requestKind: "question" as const } : {}),
  });
}

function mapOpenCodeSyntheticLifecycle(input: unknown, state: "working", occurredAt: number): NormalizedAgentLifecycleEvent | null {
  const sessionId = getEventSessionId(input);
  return sessionId ? createNormalizedAgentLifecycleEvent({ agent: "opencode", sessionId, state, occurredAt }) : null;
}

export function shouldIgnoreOpenPetsTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");
  return /(?:^|[_:-])openpets_(?:openpets_)?(?:status|say|react)$/.test(normalized) || /^openpets_(?:status|say|react)$/.test(normalized);
}

export function getDefaultOpenCodeThrottlePath(): string {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "OpenPets", "opencode-hook-throttle.json");
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  if (stateHome) return join(stateHome, "openpets", "opencode-hook-throttle.json");
  return join(tmpdir(), `openpets-${safeUid()}`, "opencode-hook-throttle.json");
}

function isTestLikeToolArgs(args: unknown): boolean {
  const command = isRecord(args) && typeof args.command === "string" ? args.command.slice(0, 300) : "";
  return /\b(test|vitest|jest|pytest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test)\b/i.test(command);
}

function getEventType(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  if (typeof event.type === "string") return event.type;
  if (isRecord(event.payload) && typeof event.payload.type === "string") return event.payload.type;
  return undefined;
}

function getEventStatusType(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const properties = isRecord(event.properties) ? event.properties : isRecord(event.payload) && isRecord(event.payload.properties) ? event.payload.properties : undefined;
  if (typeof properties?.status === "string") return properties.status;
  const status = isRecord(properties?.status) ? properties.status : undefined;
  return typeof status?.type === "string" ? status.type : undefined;
}

function getEventSessionId(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const properties = isRecord(event.properties) ? event.properties : isRecord(event.payload) && isRecord(event.payload.properties) ? event.payload.properties : undefined;
  const value = properties?.sessionID ?? properties?.sessionId ?? event.sessionID ?? event.sessionId;
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x1F\x7F]/.test(value) ? value : undefined;
}

function getEventPermission(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const properties = isRecord(event.properties) ? event.properties : isRecord(event.payload) && isRecord(event.payload.properties) ? event.payload.properties : undefined;
  if (typeof properties?.permission === "string") return properties.permission;
  if (Array.isArray(properties?.patterns)) {
    const hit = properties.patterns.find((pattern) => typeof pattern === "string" && shouldIgnoreOpenPetsTool(pattern));
    if (typeof hit === "string") return hit;
  }
  return undefined;
}

function defaultSchedule(work: () => Promise<void>): void {
  queueMicrotask(() => { void work(); });
}

function sanitizeDebugError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']{2,}/g, "<path>")
    .replace(/\b(api[_-]?key|secret|password|token)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .slice(0, 200);
}

function safeUid(): string {
  try { return String(userInfo().uid); } catch { return "user"; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
