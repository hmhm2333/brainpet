# packages/claude/src/

## Files

- **index.ts**: Barrel export (6 lines). Re-exports all public modules.
- **cli.ts**: CLI entry (51 lines). Command routing for `hook`, `doctor-hooks`, `install-hooks`, `uninstall-hooks`.
- **hooks.ts**: Hook execution engine. It retains reaction/throttle behavior and also maps stable Claude session ids onto the shared lifecycle contract (`working`, `waiting`, `ready`, `blocked`, `idle`) for Primary Companion aggregation.
- **hook-settings.ts**: Settings management for seven lifecycle hooks including `SessionEnd`, with install/uninstall/doctor, path safety, backup logic, and Windows-safe quoted command paths.
- **hook-messages.ts**: Speech re-exports (1 line). Re-exports from `@open-pets/agent-events`.
- **claude-code.ts**: MCP configuration (265 lines). `buildClaudeMcpPreview()`, `buildOpenPetsMcpServerCommand()`, `parseClaudeMcpGetOutput()`, `classifyClaudeMcpStatus()`, path validation, asar handling.
- **check-claude-code.ts**: MCP contract validation (excluded from detailed documentation).
- **check-claude-hooks.ts**: Hooks contract validation (excluded from detailed documentation).
