import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";

import { createOpenPetsClient, type OpenPetsClient, type OpenPetsReaction, type TargetProduct } from "@open-pets/client";
import { createNormalizedAgentLifecycleEvent, validateHookSpeech as validateSharedHookSpeech, type NormalizedAgentLifecycleEvent } from "@open-pets/agent-events";
import { createInstallerPlan, defineAdapterDescriptor, type InstallerPlan, type TargetProfile } from "@open-pets/adapter-core";

import type { HookSpeechCategory } from "./hook-messages.js";

export type ClaudeHookEventName = "UserPromptSubmit" | "PreToolUse" | "PermissionRequest" | "Notification" | "Stop" | "StopFailure" | "SessionEnd";

export interface ClaudeHookDecision {
  readonly eventName?: string;
  readonly reaction?: OpenPetsReaction;
  readonly speechCategory?: HookSpeechCategory;
}

export interface ClaudeHookOptions {
  readonly product?: TargetProduct;
  readonly client?: OpenPetsClient;
  readonly configuredPetId?: string;
  readonly projectLocal?: boolean;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly throttlePath?: string;
  readonly debug?: boolean;
}

export const claudeAdapterDescriptor = defineAdapterDescriptor({
  id: "claude",
  displayName: "Claude Code",
  supportedProducts: ["brainpet", "openpets"],
  automaticLifecycle: true,
  lifecycleMethod: "agent.activity",
  installerKind: "claude-hooks",
  capabilities: { lifecycle: "implemented", taskNavigation: "unavailable", requestActions: "unavailable", message: "unavailable", voice: "unavailable" },
});

export function createClaudeInstallerPlan(target: TargetProduct | TargetProfile, scope: "global" | "project", mode: InstallerPlan["mode"] = "install"): InstallerPlan {
  return createInstallerPlan({ providerId: claudeAdapterDescriptor.id, installerKind: claudeAdapterDescriptor.installerKind, target, scope, mode });
}

const maxHookInputBytes = 64 * 1024;
const maxProjectLocalSettingsBytes = 256 * 1024;

export async function runClaudeHookFromStdin(stdin: NodeJS.ReadStream = process.stdin, options: ClaudeHookOptions = {}): Promise<number> {
  try {
    const raw = await readLimitedStdin(stdin, maxHookInputBytes);
    await handleClaudeHookPayload(raw, options);
    return 0;
  } catch (error) {
    if (options.debug || process.env.OPENPETS_DEBUG === "1") {
      process.stderr.write(`OpenPets Claude hook ignored error: ${sanitizeDebugError(error)}\n`);
    }
    return 0;
  }
}

export async function handleClaudeHookPayload(raw: string, options: ClaudeHookOptions = {}): Promise<ClaudeHookDecision | null> {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseHookPayload(raw);
  } catch {
    return null;
  }
  const decision = mapClaudeHookEvent(parsed);
  const lifecycle = mapClaudeLifecycleEvent(parsed, options.now?.() ?? Date.now());
  if (!lifecycle) return decision;
  if (!options.projectLocal && hasProjectLocalOpenPetsHook()) return decision;

  try {
    const client = options.client ?? createTargetedClient(options.product);
    await client.reportAgentActivity(lifecycle);
  } catch (error) {
    if (options.debug) process.stderr.write(`OpenPets Claude lifecycle ignored error: ${sanitizeDebugError(error)}\n`);
  }
  return decision;
}

export function hasProjectLocalOpenPetsHook(projectDir = process.env.CLAUDE_PROJECT_DIR): boolean {
  if (!projectDir || /[\0\r\n]/.test(projectDir)) return false;
  try {
    const projectReal = realpathSync(projectDir);
    const settingsPath = join(projectReal, ".claude", "settings.local.json");
    const settingsReal = realpathSync(settingsPath);
    const rel = relative(projectReal, settingsReal);
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    const settingsLstat = lstatSync(settingsPath);
    if (settingsLstat.isSymbolicLink()) return false;
    const settingsStat = statSync(settingsPath);
    if (!settingsStat.isFile() || settingsStat.size <= 0 || settingsStat.size > maxProjectLocalSettingsBytes) return false;
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    return containsProjectLocalOpenPetsHook(settings);
  } catch {
    return false;
  }
}

function containsProjectLocalOpenPetsHook(value: unknown): boolean {
  if (typeof value === "string") return value.includes("--openpets-managed") && value.includes("--project-local");
  if (Array.isArray(value)) return value.some(containsProjectLocalOpenPetsHook);
  if (isRecord(value)) return Object.values(value).some(containsProjectLocalOpenPetsHook);
  return false;
}

export function parseHookPayload(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, "utf8") > maxHookInputBytes) throw new Error("Claude hook payload is too large.");
  const parsed = JSON.parse(raw || "{}") as unknown;
  return isRecord(parsed) ? parsed : {};
}

export function mapClaudeHookEvent(payload: Record<string, unknown>): ClaudeHookDecision | null {
  const eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : undefined;
  if (eventName === "UserPromptSubmit") return { eventName, reaction: "thinking" };
  if (eventName === "PermissionRequest") return { eventName, reaction: "waiting", speechCategory: "permission" };
  if (eventName === "Notification") return { eventName };
  if (eventName === "Stop") return { eventName, reaction: "success" };
  if (eventName === "StopFailure") return { eventName, reaction: "error", speechCategory: "error" };
  if (eventName === "SessionEnd") return { eventName };
  if (eventName === "PreToolUse") return { eventName, reaction: classifyToolReaction(payload) };
  return eventName ? { eventName } : null;
}

function createTargetedClient(product: TargetProduct | undefined): OpenPetsClient {
  if (!product) throw new Error("Claude hook requires an explicit brainpet or openpets product target.");
  return createOpenPetsClient({ target: product, connectTimeoutMs: 500, responseTimeoutMs: 500 });
}

export function mapClaudeLifecycleEvent(payload: Record<string, unknown>, occurredAt = Date.now()): NormalizedAgentLifecycleEvent | null {
  const eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : undefined;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
  if (!sessionId) return null;
  const state = eventName === "UserPromptSubmit" || eventName === "PreToolUse" ? "working"
    : eventName === "PermissionRequest" ? "waiting"
      : eventName === "Stop" ? "ready"
        : eventName === "StopFailure" ? "blocked"
          : eventName === "SessionEnd" ? "idle"
            : undefined;
  if (!state) return null;
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
  return createNormalizedAgentLifecycleEvent({
    agent: "claude",
    sessionId,
    ...(turnId ? { turnId } : {}),
    state,
    occurredAt,
    ...(eventName === "PermissionRequest" ? { requestKind: "permission" as const } : {}),
  });
}

export function validateHookSpeech(message: string): string {
  return validateSharedHookSpeech(message);
}

export function getDefaultThrottlePath(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, "OpenPets", "claude-hook-throttle.json");
  }
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  if (stateHome) return join(stateHome, "openpets", "claude-hook-throttle.json");
  const uid = safeUid();
  return join(tmpdir(), `openpets-${uid}`, "claude-hook-throttle.json");
}

function classifyToolReaction(payload: Record<string, unknown>): OpenPetsReaction | undefined {
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") return "editing";
  if (toolName === "Bash") {
    const command = extractBashCommand(payload.tool_input);
    return /\b(test|vitest|jest|pytest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test)\b/i.test(command) ? "testing" : undefined;
  }
  return undefined;
}

function extractBashCommand(value: unknown): string {
  return isRecord(value) && typeof value.command === "string" ? value.command.slice(0, 300) : "";
}

function readLimitedStdin(stdin: NodeJS.ReadStream, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxBytes) reject(new Error("Claude hook stdin is too large."));
    });
    stdin.on("error", reject);
    stdin.on("end", () => resolve(buffer));
  });
}

function sanitizeDebugError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:[A-Za-z]:)?[\\/][^\s"']{2,}/g, "<path>").slice(0, 200);
}

function safeUid(): string {
  try { return String(userInfo().uid); } catch { return "user"; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
