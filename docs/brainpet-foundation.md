# BrainPet foundation plan

## Confirmed product decisions

- BrainPet is a desktop brain-training pet built from OpenPets.
- The initial product uses an OpenPets host fork plus a first-party training
  plugin rather than a separate companion application.
- The training trigger should read visually as part of the pet, preferably a
  conspicuous accessory such as a badge, pendant, antenna, or held device.
- Training appears in a small transparent surface anchored to the pet, not a
  browser tab, full-screen experience, or unrelated taskbar application.
- Game content is not the first technical risk. Host integration and a reusable
  task boundary come first.
- Scores should produce pet feedback, but the first version remains local.

## Architecture boundary

BrainPet keeps responsibilities separated:

```text
OpenPets-derived desktop host
  pet rendering and motion
  hotspot hit testing
  transparent overlay lifecycle
  plugin sandbox and permissions
            |
            v
BrainPet training plugin
  session orchestration
  task registry
  local history
  pet reward mapping
            |
            v
Task modules
  trial generation
  input handling
  result production
```

The host must not contain individual training-task rules. A task module must not
directly mint durable rewards, write arbitrary score records, or control desktop
windows.

## Milestone 1: host interaction spike

Deliver one visible pet accessory hotspot and one empty anchored overlay.

Acceptance:

- The pet remains draggable outside the hotspot.
- Clicking the hotspot emits a stable hotspot ID.
- The overlay is transparent, frameless, always on top, and absent from the
  taskbar.
- It opens near the pet, stays on the active display, and closes cleanly.
- Transparent regions preserve desktop click-through where practical.
- Disabling the BrainPet feature restores ordinary OpenPets interaction.

## Milestone 2: plugin contract

Expose only the host capabilities the training plugin needs:

- subscribe to a declared pet hotspot;
- open, update, reposition, hide, and close one anchored overlay;
- receive clone-safe overlay messages;
- request approved pet reactions and sounds;
- persist quota-bound local state.

The overlay remains sandboxed: no Node integration, arbitrary navigation,
unapproved network access, or direct renderer handles.

## Milestone 3: task module contract

Each task definition should provide:

- stable ID and semantic version;
- title and short instruction;
- supported input modes;
- round duration and parameter schema;
- deterministic session creation from a seed;
- trial events and response events;
- a normalized result containing accuracy, reaction-time summaries, omissions,
  commissions, completion state, and task-specific metrics;
- a renderer entry that cannot directly mutate durable results.

The session orchestrator timestamps raw events and validates the submitted
result. This provides a future boundary for analytics or leaderboards without
requiring them now.

## Milestone 4: demonstration tasks

Implement only enough variety to validate the contract:

1. A response-inhibition task using a generic go/no-go paradigm.
2. An interference-control task using a generic color-word or spatial conflict
   paradigm with original presentation.
3. Optionally, a short spatial sequence task if it reveals a missing capability
   in the task contract.

These are demonstrations, not a finalized cognitive curriculum. Parameters and
scoring remain transparent and versioned.

## Milestone 5: local pet loop

Record sessions locally and translate them into restrained pet feedback:

- completion always receives a positive acknowledgement;
- performance can change reaction intensity or animation choice;
- poor scores never punish, sicken, or starve the pet;
- repeated sessions cannot create unbounded reward events;
- the local record distinguishes task performance from pet-progression events.

## Deferred decisions

- Final character and visual identity.
- Whether the accessory is embedded in sprites or host-rendered above them.
- Commercial model, open-source boundary, accounts, cloud services, and stores.
- Competitive rankings, anti-cheat, adaptive training, and long-term progression.
- Final product claims and evidence language.

## First implementation slice

The next code change should implement no task at all. It should add a feature-
flagged hotspot descriptor to the default pet surface and use it to open an
empty transparent overlay containing only a close control and diagnostic text.
That slice determines whether the intended interaction survives real OpenPets
dragging, click-through, multi-display, focus, sandbox, and lifecycle behavior.

