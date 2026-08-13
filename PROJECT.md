# BrainPet

BrainPet is a desktop companion that turns short periods of agent waiting time
into brief cognitive training sessions. It starts from an OpenPets source
snapshot, keeps the original MIT notices intact, and retains the full public
history through the read-only `upstream` remote and a local preservation ref.

Tagline: **Train your brain. Grow your pet.**

## Current objective

Build a stable reusable runtime and stage first, then prove this loop with two
formal game modules:

1. The user clicks a visible accessory or body-area control on the pet.
2. The pet launches a small transparent, frameless training surface nearby.
3. One of two task modules is selected automatically and runs for a 45–60
   second bounded round.
4. The result is recorded locally and produces an immediate pet reaction.
5. The surface collapses without interrupting the user's main workspace.

## Foundation scope

- Preserve existing OpenPets pet, agent integration, and plugin behavior.
- Add a host-owned pet hotspot primitive.
- Add a host-owned transparent anchored overlay primitive for sandboxed plugins.
- Build a task-neutral runtime for lifecycle, timing, input, sessions, storage,
  failure recovery, and pet feedback.
- Build a reusable stage for pixel rendering, assets, animation, audio, HUD,
  scaling, pause, settlement, and diagnostics.
- Define a runtime-neutral task module contract.
- Pass the infrastructure stress, soak, DPI, multi-display, failure, and second-
  dummy-module gates before formal game development begins.
- Ship one go/no-go task and one continuous-updating / avoid-repetition task,
  with original game expression and no separate tutorial flow.
- Store results locally and map completion/performance to pet feedback.

## Explicit non-goals

- Accounts, cloud sync, leaderboards, payments, subscriptions, or an economy.
- Medical, diagnostic, IQ-increase, or treatment claims.
- A complete training curriculum or adaptive recommendation system.
- Copying Lumosity, Devil's Brain Training, or another product's names, art,
  copy, level data, scoring curves, sound, or distinctive interaction design.
- A generalized third-party marketplace before the first-party loop works.

## Repository model

- `origin`: private BrainPet repository.
- `upstream`: public OpenPets repository.
- `main`: imported OpenPets source-snapshot baseline for BrainPet.
- `codex/foundation`: BrainPet product and architecture work.
- `openpets-history`: local preservation ref for the original cloned history.

## Minimum validation

Before dependencies are installed:

```powershell
git status --short
git remote -v
```

After the existing pnpm workspace dependencies are available:

```powershell
pnpm typecheck
pnpm --filter @open-pets/desktop test
```

Feature work must also add the narrowest behavior-level tests for hotspot hit
testing, overlay lifecycle, runtime state transitions, monotonic timing, input
normalization, plugin isolation, task result validation, and abnormal cleanup.

## Lifecycle

This is an active Windows product project under `D:\Dev\Projects\products`.
Do not move it to express status. Update this file when the product boundary,
verification contract, upstream strategy, or lifecycle materially changes.
