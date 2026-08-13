# packages/

Monorepo workspace containing all OpenPets npm packages. Each package is publishable with its own versioning and follows the workspace ESM/TypeScript conventions.

## Responsibility

Provides modular, reusable components for the OpenPets ecosystem:
- **pet-format**: Package marker interface for type identification
- **agent-events**: Speech pools and validation for agent feedback messages
- **client**: Core IPC client for communicating with OpenPets desktop app
- **cli**: Main CLI tool for configuring agents, creating plugins from templates, and managing pets
- **mcp**: MCP stdio server implementation for agent integration (status, reaction, speak)
- **opencode**: OpenCode editor integration (plugin hooks, config management)
- **claude**: Claude Code integration (hook execution, config management)
- **cursor**: Cursor editor integration (MCP configuration, project rules)
- **pi**: Pi coding-agent extension integration (event handling, slash commands)
- **install-pet**: Standalone pet installer from gallery catalog
- **sdk**: Public SDK v3 type definitions and deterministic testing harness for plugin authors (SuperPlugins)

## Design/Patterns

**Workspace Pattern**: Uses pnpm workspaces with `workspace:*` dependencies for internal linking.

**Package Structure**: Each package follows a consistent structure:
- `src/` - TypeScript source
- `dist/` - Compiled output (not committed)
- `package.json` - Standard npm metadata with exports map and dependencies
- `contracts/` - Runtime contract validation definitions

**ESM-First**: All packages are ESM (`"type": "module"`) with dual exports for types.

**Versioning**: Packages align across active integrations, supporting SDK v3 and manifestVersion 3 plugin architecture.

## Data & Control Flow

```
CLI Entry (packages/cli/src/index.ts)
    ├── Configures Claude → @open-pets/claude
    ├── Configures OpenCode → @open-pets/opencode
    ├── Configures Cursor → @open-pets/cursor
    ├── Spawns MCP server → @open-pets/mcp
    └── Uses IPC client → @open-pets/client

MCP Server (packages/mcp/src/index.ts)
    ├── Registers tools (status, react, say)
    └── Communicates via @open-pets/client

OpenCode Plugin (packages/opencode/src/plugin.ts)
    └── Hooks into editor events → @open-pets/client

Claude Hooks (packages/claude/src/hooks.ts)
    └── Processes hook events → @open-pets/client

Cursor Setup (packages/cursor/src/cursor-project-setup.ts)
    └── Writes MCP config + rules → @open-pets/client

Pi Extension (packages/pi/src/extension.ts)
    └── Registers Pi extension hooks/commands → @open-pets/client

SDK Type definitions & Test Harness (packages/sdk/)
    ├── Defines OpenPetsContext, permissions, assets, bubbles, alerts, panels, audio, events, bus, storage, AI, secrets, voice, files, system, commands
    └── createTestHarness() runs plugins against fake time/events/storage/network without Electron
```

## Integration Points

**Inter-Package Dependencies**:
- `cli` depends on: `client`, `claude`, `mcp`, `opencode`, `cursor`
- `mcp` depends on: `client`
- `claude` depends on: `client`, `agent-events`
- `opencode` depends on: `client`, `agent-events`
- `cursor` depends on: `client`
- `pi` depends on: `client`, `agent-events`
- `install-pet` depends on: `client`
- `sdk` (type-only and test harness) is consumed by template code scaffolded by `cli`
- `desktop` mirrors `sdk` through `apps/desktop/src/plugin-sdk-bridge.ts` and conformance checks

**External Integrations**:
- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `jsonc-parser` - JSON with comments parsing for OpenCode configs
- `yauzl` - ZIP extraction for pet downloads
- `zod` - Schema validation in MCP tools

**Desktop App Communication**:
All packages ultimately communicate with the OpenPets desktop app via the IPC protocol defined in `@open-pets/client` (using Unix sockets, Windows named pipes, or TCP for cross-platform/WSL).

## Directory Map

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `agent-events/` | Shared agent event message pools and validators. | [View Map](agent-events/codemap.md) |
| `claude/` | Claude Code hook/MCP/settings integration package. | [View Map](claude/codemap.md) |
| `client/` | Desktop IPC discovery and client API package. | [View Map](client/codemap.md) |
| `cli/` | User CLI for setup, pet commands, MCP launch, plugin scaffolding, and plugin validation. | [View Map](cli/codemap.md) |
| `cursor/` | Cursor MCP/rules integration package. | [View Map](cursor/codemap.md) |
| `install-pet/` | Standalone gallery pet installer package. | [View Map](install-pet/codemap.md) |
| `mcp/` | OpenPets MCP stdio server package. | [View Map](mcp/codemap.md) |
| `opencode/` | OpenCode plugin/config integration package. | [View Map](opencode/codemap.md) |
| `pet-format/` | Pet package identity marker package. | [View Map](pet-format/codemap.md) |
| `pi/` | Pi coding-agent extension integration package. | [View Map](pi/codemap.md) |
| `sdk/` | Public plugin SDK v3 type surface and test harness. | [View Map](sdk/codemap.md) |
