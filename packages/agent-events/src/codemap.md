# packages/agent-events/src/

## Files

- **index.ts**: Shared speech pools plus the privacy-minimal provider lifecycle builder. `createNormalizedAgentLifecycleEvent()` is the provider-neutral boundary used by Claude and OpenCode; its output has no fields for prompt, transcript, cwd, or tool payloads.
- **check-agent-events.ts**: Contract validation (excluded from detailed documentation).
