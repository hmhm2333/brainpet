import { agentActivityMethod, agentActivitySchemaVersion, lifecycleStates } from "./generated-contract.mjs";

const hookState = Object.freeze({
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "ready",
  ErrorOccurred: "blocked",
  SessionEnd: "idle",
});

export const codexAdapterDescriptor = Object.freeze({
  id: "codex",
  displayName: "Codex",
  supportedProducts: ["brainpet"],
  automaticLifecycle: true,
  lifecycleMethod: agentActivityMethod,
  installerKind: "codex-plugin",
  capabilities: Object.freeze({ lifecycle: "implemented", taskNavigation: "unavailable", requestActions: "unavailable", message: "unavailable", voice: "unavailable" }),
});

export function selectLifecycleEvent(input, occurredAt = Date.now()) {
  if (!isRecord(input)) return null;
  const state = hookState[input.hook_event_name];
  if (!state || !lifecycleStates.includes(state) || !isIdentifier(input.session_id, 160)) return null;
  const turnId = isIdentifier(input.turn_id, 160) ? input.turn_id : undefined;
  return {
    schemaVersion: agentActivitySchemaVersion,
    agent: "codex",
    sessionId: input.session_id,
    ...(turnId ? { turnId } : {}),
    state,
    occurredAt,
    capabilities: ["observeLifecycle"],
  };
}

export function shouldWriteJsonResult(input) {
  return isRecord(input) && input.hook_event_name === "Stop";
}

function isIdentifier(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\x00-\x1F\x7F]/.test(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
