# packages/agent-events/

Generated lifecycle/privacy facts plus optional speech validation.

## Responsibility

Provides the canonical automatic lifecycle states, schema/method constants,
privacy rejected-field list, normalized event builder, and categorized manual
speech pools. Automatic adapters use only the lifecycle contract.

`assertAgentActivityContract()` is the shared strict client/server gate. It
requires every generated required field and rejects privacy fields before any
consumer-specific capability/request validation.

## Design

**Category-Based Pools**: Four speech categories with curated message pools:
- `thinking`: "Thinking it through", "Let me check", etc.
- `success`: "Done", "That worked", etc.
- `error`: "Something failed", "Needs another look", etc.
- `permission`: "Approval needed"

**Validation Strategy**: Regex-based validation rejecting:
- Multi-line content (`\r|\n`)
- Code-like patterns (backticks, keywords, braces)
- URLs (`https?://`, `www.`)
- File paths (slashes, drive letters)
- Secrets (`api_key`, `secret`, `password`, `token`)

**Random Selection**: `pickHookSpeech()` uses bounded random index selection with fallback chains.

## Flow

```
Agent Event → pickHookSpeech(category, randomFn) → validateHookSpeech(message) → Safe message
```

## Integration Points

**Consumers**:
- `@open-pets/client` and desktop protocol - lifecycle validation
- `@open-pets/claude` and `@open-pets/opencode` - automatic event normalization

**Exports**:
- `hookSpeechPools` - Readonly record of message arrays
- `pickHookSpeech()` - Random selection with bounds checking
- `validateHookSpeech()` - Security validation
- `HookSpeechCategory` - Type union for categories
- `normalizedAgentLifecycleStates` / `agentActivityMethod` - generated protocol facts
- `agentActivityPrivacyRejectedFields` - shared privacy boundary
- `assertAgentActivityContract()` - strict generated required-field/privacy envelope validation
