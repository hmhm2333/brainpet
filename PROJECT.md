# BrainPet

BrainPet is a desktop companion that turns short periods of agent waiting time
into brief cognitive training sessions. It starts from an OpenPets source
snapshot, keeps the original MIT notices intact, and retains the full public
history through the read-only `upstream` remote and a local preservation ref.

Tagline: **Train your brain. Grow your pet.**

## Current objective

Build the smallest credible foundation that proves this loop:

1. The user clicks a visible accessory or body-area control on the pet.
2. The pet launches a small transparent, frameless training surface nearby.
3. A task module runs for a short bounded round.
4. The result is recorded locally and produces an immediate pet reaction.
5. The surface collapses without interrupting the user's main workspace.

## Foundation scope

- Preserve existing OpenPets pet, agent integration, and plugin behavior.
- Add a host-owned pet hotspot primitive.
- Add a host-owned transparent anchored overlay primitive for sandboxed plugins.
- Define a runtime-neutral task module contract.
- Ship two or three generic demonstration tasks based on established task
  paradigms, without copying commercial product expression.
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
testing, overlay lifecycle, plugin isolation, and task result validation.

## Lifecycle

This is an active Windows product project under `D:\Dev\Projects\products`.
Do not move it to express status. Update this file when the product boundary,
verification contract, upstream strategy, or lifecycle materially changes.
