# packages/pi/src/

Source for the OpenPets Pi integration package.

## Responsibility

- `extension.ts`: Default Pi extension export. Wraps `createOpenPetsPiExtension()` for Pi loader consumption.
- `index.ts`: Public package exports including extension factory, runtime helpers, types, and classification utilities.
- `runtime.ts`: Explicit command parsing/dispatch plus side-effect-free legacy classifiers; `handleEvent` is a compatibility no-op.
- `check-pi.ts`: Unit-style contract checks for event classification, command parsing, privacy rejection corpus, non-blocking scheduling, and extension registration.
- `check-pi-compat.ts`: Pi-style compatibility smoke checks for event handlers whose payloads do not include a `type` field.

## Design/Patterns

- **Event normalization**: `normalizePiEvent()` wraps raw Pi events into `PiEventEnvelope` with consistent `type`/`payload` structure.
- **Event classification**: `classifyPiEvent()` maps Pi lifecycle events to OpenPets reactions via pure function with no side effects.
- **Tool classification**: `classifyPiToolExecutionStart()` inspects tool names (not arguments) to categorize as editing/running/testing/working.
- **Command parsing**: `parseOpenPetsCommand()` uses simple string splitting with validation, rejecting multi-line, oversized, or secret-containing speech.
- **No automatic transport**: `createOpenPetsPiExtension()` registers `/openpets` only and never calls `api.on()`.

## Flow

**Extension initialization**:
```
extension.ts default export
  -> createOpenPetsPiExtension(pi, options)
  -> createOpenPetsPiRuntime(options) → runtime
  -> Register /openpets command via api.registerCommand()
  -> Return runtime (handleEvent, handleCommand)
```

**Command handling**:
```
/openpets <args>
  -> runtime.handleCommand(args, ctx)
  -> parseOpenPetsCommand(args) → OpenPetsPiCommand
  -> executeCommand(command, client, ctx)
  -> Synchronous OpenPets client calls
  -> ctx.ui.notify() for user feedback
```

## Integration

- **Pi API**: Expects `OpenPetsPiExtensionApi` with `on(event, handler)` and `registerCommand(name, spec)` methods.
- **OpenPets client**: Used only for explicit `/openpets` commands.
- **Agent events**: Imports `validateHookSpeech` for explicit safe speech validation.
- **Test doubles**: Both check files inject mock clients/schedulers to verify behavior without desktop dependency.

## Important constraints

- Do not add `pi.registerTool()` in Phase 21 MVP.
- Do not inspect content-heavy Pi events such as prompt/message/tool result streams for speech.
- Do not add automatic Pi subscriptions unless Pi is formally registered and routed through `agent.activity` conformance.
- All speech validation must reject secrets, paths, URLs, and code snippets.
