import { buildAgentActivityPayload, type AgentActivityInput, type AgentActivityPayload } from "./agent-activity-payload.js";

export type HostAgentActivityHandler = (payload: AgentActivityPayload) => void;

const handlers = new Set<HostAgentActivityHandler>();

export function publishHostAgentActivity(activity: AgentActivityInput): void {
  const payload = buildAgentActivityPayload(activity);
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch {
      // Host observers are isolated from the command/lifecycle path.
    }
  }
}

export function subscribeHostAgentActivity(handler: HostAgentActivityHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
