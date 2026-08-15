# OpenPets Documentation

This folder is the maintained, conceptual documentation for the OpenPets
workspace. It explains *concepts, contracts, and where things live* - it
deliberately avoids pasting code, which rots. When a doc points you at a file,
that file is the source of truth; the doc explains why it matters and how the
pieces fit.

For per-folder structural detail (every symbol, edge, and responsibility), see
the `codemap.md` files throughout the tree, starting at the root `codemap.md`.
Docs here are the *narrative* layer on top of those maps.

## Start here

- **[architecture.md](architecture.md)** - the one-page mental model: runtime
  topology, the package spine, end-to-end flows, cross-cutting invariants, and a
  glossary. Read this first.

## Desktop app

- **[desktop.md](desktop.md)** - the Electron app: process model, tray-first UX,
  Control Center, windows, app state, lifecycle, security model, logging, CSP.
- **[ipc.md](ipc.md)** - the local IPC protocol and `@open-pets/client`:
  discovery, transports, the lease model, request methods, security.
- **[pets.md](pets.md)** - the pet model end to end: spritesheets, reactions,
  reaction→animation mapping, installation, Codex pets, motion.
- **[lan-mode.md](lan-mode.md)** - experimental LAN office-pet mode: one
  shared default pet moves between PCs on the same network.

## Content & catalogs (app-facing web data)

- **[catalog.md](catalog.md)** - the pet and plugin catalogs the app consumes:
  v3/v2 contracts, pagination, search, install/manifest artifacts, R2 ZIP
  hosting, and how the desktop reads them.

## Agent integrations

- **[agent-integrations.md](agent-integrations.md)** - how Claude Code, MCP,
  OpenCode, Cursor, Pi, and the BrainPet Codex bridge turn agent activity into
  pet reactions, plus the CLI that ties the published integrations together.

## BrainPet

- **[brainpet-v1-product-requirements.md](brainpet-v1-product-requirements.md)** -
  V1 product scope, runtime-first delivery order, and acceptance boundaries.
- **[brainpet-runtime.md](brainpet-runtime.md)** - the currently implemented
  transparent stage, session ownership, task loading, and host boundaries.
- **[brainpet-distribution.md](brainpet-distribution.md)** - the two-component
  runtime/bridge release architecture, end-user install flow, public plugin
  path, compatibility, and rollback gates.
- **[brainpet-primary-companion-plan.md](brainpet-primary-companion-plan.md)** -
  the current Primary Companion iteration: native-pet parity tiers, provider
  capabilities, auto-wake, action safety, cross-platform gates, and rollback.
- **[brainpet-m5.1-architecture-hardening.md](brainpet-m5.1-architecture-hardening.md)** -
  the M5.1 composition-root, rollback, protocol, installation-state, and real
  release validation hardening required before the next product milestone.
- **[brainpet-codex-local-install.md](brainpet-codex-local-install.md)** - the
  current-machine private-test install, Codex Bridge upgrade, verification, and
  rollback procedure.
- **[brainpet-gonogo-game-spec.md](brainpet-gonogo-game-spec.md)** - the target
  Go/No-Go game, pet-to-reaction-zone interaction rig, independent placement,
  scoring V2, telemetry, and implementation acceptance criteria.
- **[brainpet-v1-parameter-freeze.md](brainpet-v1-parameter-freeze.md)** - the
  current implemented task parameters and their approval/versioning rules.

## Plugins & SDK

- **[plugins.md](plugins.md)** - the plugin platform: manifest schema,
  permission model, runtime, sandboxed JS host, catalog vs local install,
  packaging and publishing, troubleshooting.
- **[official-plugins.md](official-plugins.md)** - the reviewed official and
  community plugin lineup, bundling/enabled defaults, and the companion-first
  behavior rules.
- **[sdk.md](sdk.md)** - the public SDK v3 contract for plugin authors: the
  capability namespaces, the permission surface, and the deterministic test
  harness.

## Internationalization

- **[i18n.md](i18n.md)** - translations across the desktop host, pet reaction
  speech, and plugins; locale fallback; `$t:` and `ctx.t()`; adding a locale.

## Developer experience, testing & release

- **[development.md](development.md)** - DX: monorepo layout, the command
  surface, dev modes, build conventions, and the npm/desktop release flows.
- **[testing-and-validation.md](testing-and-validation.md)** - the full quality
  gate: behavior tests, contract tests, runtime checks, plugin release
  validators (`validate-release` / `validate-live`), catalog verification, and
  what "production-valid" means before shipping.

## How to keep these docs healthy

- When you change behavior, update the matching doc in the same change. Stale
  docs are worse than missing ones.
- Keep code out of docs. Reference the file that owns the behavior instead.
- Plugin/catalog/i18n changes have an explicit "update these docs" rule in
  `AGENTS.md` - honor it.
- Ongoing improvement ideas and known issues are tracked in the root
  `improvements.md`, not here.
