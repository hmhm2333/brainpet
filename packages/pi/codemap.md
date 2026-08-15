# packages/pi/

Publishable npm package for the OpenPets Pi coding-agent integration.

## Responsibility

- Exposes `@open-pets/pi` as a Pi package with a Pi extension resource.
- Deliberately does not subscribe to Pi session/tool activity; Pi is not a registered automatic lifecycle adapter.
- Registers a user slash command namespace, `/openpets`, for status, test, react, and say commands.
- Keeps MVP behavior default-pet-only and non-blocking; no Pi model-callable tools are registered.

## Design/Patterns

- **Package structure**: Standard npm package with `main`/`types` pointing to `dist/index.js`, Pi extension declared in `pi.extensions` array.
- **Dual exports**: Main package exports (`index.ts`) and dedicated extension entry (`extension.ts`) for Pi loader consumption.
- **Peer dependency**: Declares optional peer dependency on `@earendil-works/pi-coding-agent` for type safety without hard coupling.
- **Explicit-only transport**: Only the user-invoked `/openpets` command handler may call the client.
- **Privacy-first**: Prompt text, assistant text, tool output, command output, file paths, URLs, and secrets are never forwarded to OpenPets.

## Flow

```text
Pi extension loader
  -> packages/pi/src/extension.ts
  -> packages/pi/src/runtime.ts
  -> @open-pets/client
  -> OpenPets desktop local IPC
```

**Command flow**:
1. User types `/openpets <command>` in Pi
2. `registerCommand()` handler invoked with args string
3. `parseOpenPetsCommand()` validates and structures command
4. `executeCommand()` performs synchronous OpenPets client calls
5. UI notifications sent via `ctx.ui.notify()`

## Integration

- **Upstream**: Consumes `@open-pets/agent-events` for speech validation and `@open-pets/client` for IPC.
- **Downstream**: Pi coding agent loads extension via `pi.extensions` manifest entry.
- **Desktop**: Communicates with OpenPets desktop app through local socket IPC (via `@open-pets/client`).
- **Commands**: `/openpets status`, `/openpets test`, `/openpets react <reaction>`, `/openpets say <message>`.

## Safety notes

- No automatic Pi event is registered or transported.
- Prompt text, assistant text, tool output, command output, file paths, URLs, and secrets are not forwarded.
