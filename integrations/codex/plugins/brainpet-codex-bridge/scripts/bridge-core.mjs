const hookState = Object.freeze({
  UserPromptSubmit: "working",
  PermissionRequest: "waiting",
  PostToolUse: "working",
  Stop: "ready",
  StopFailure: "blocked",
  SessionEnd: "idle",
});

export function selectLifecycleEvent(input, occurredAt = Date.now()) {
  if (!isRecord(input)) return null;
  const state = hookState[input.hook_event_name];
  if (!state || !isIdentifier(input.session_id, 160)) return null;
  const turnId = isIdentifier(input.turn_id, 160) ? input.turn_id : undefined;
  return {
    schemaVersion: 1,
    agent: "codex",
    sessionId: input.session_id,
    ...(turnId ? { turnId } : {}),
    state,
    occurredAt,
    capabilities: ["observeLifecycle"],
    ...(input.hook_event_name === "PermissionRequest" ? { request: { kind: "permission" } } : {}),
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
