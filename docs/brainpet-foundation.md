# BrainPet foundation plan

Implementation status (2026-08-13): the Host Adapter, Runtime Core, task
contract, Stage Exerciser, local result store, pixel stage, and two first-party
task modules are implemented on `codex/foundation`. The 100-cycle virtual soak,
deterministic task tests, real Electron pet-to-stage smoke test, renderer crash
isolation, visual screenshots, and unpacked Windows package contract pass.
Final character art, task parameter review, sound, lock-screen behavior, and a
signed installer remain later hardening work.

## Confirmed product decisions

- BrainPet is a desktop brain-training pet built from OpenPets.
- The initial product uses an OpenPets host fork plus a first-party training
  plugin rather than a separate companion application.
- The training trigger should read visually as part of the pet, preferably a
  conspicuous accessory such as a badge, pendant, antenna, or held device.
- Training appears in a small transparent surface anchored to the pet, not a
  browser tab, full-screen experience, or unrelated taskbar application.
- The surface targets roughly one ninth of the active display work area, with
  size limits for small, high-DPI, and 4K displays.
- A click immediately selects one of two current levels and starts a 45–60
  second round. V1 has no game lobby, map, level picker, or tutorial screen.
- The pet character, pixel scale, palette, props, and feedback create visual
  consistency; V1 does not require a narrative world.
- The stable runtime and stage are the first product deliverable. Formal game
  development starts only after the infrastructure completion gate passes.
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
BrainPet runtime core
  lifecycle state machine
  monotonic clock and input
  session and persistence
  session orchestration
  task registry
  local history
  pet reward mapping
            |
            v
BrainPet stage
  rendering and asset loading
  sprite, animation, audio, and HUD
  scaling, pause, settlement, and diagnostics
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

## Milestone 2: runtime and stage contract

Expose only the host capabilities the BrainPet runtime needs:

- subscribe to a declared pet hotspot;
- open, update, reposition, hide, and close one anchored overlay;
- receive clone-safe overlay messages;
- request approved pet reactions and sounds;
- persist quota-bound local state.

The overlay remains sandboxed: no Node integration, arbitrary navigation,
unapproved network access, or direct renderer handles.

Build the task-neutral runtime and stage before any formal game:

- lifecycle state machine, monotonic clock, normalized input, and pause/resume;
- task registry, deterministic sessions, local events, and validated results;
- logical resolution, pixel scaling, asset manifests, sprite animation, audio,
  HUD, settlement, and safe renderer boundaries;
- a development-only Stage Exerciser for deterministic lifecycle, rendering,
  input, timing, failure, DPI, and multi-display tests.

## Milestone 3: task module contract and exerciser

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

Use the contract to implement the development-only Stage Exerciser and a second
dummy module before formal game work.

## Milestone 4: infrastructure completion gate

Do not begin formal game development until:

- the Stage Exerciser completes 100 automated open/run/close cycles without
  orphan windows, stale sessions, or dead hotspots;
- a 30-minute soak test shows no obvious continuing memory growth;
- focus loss, pause, lock, display changes, renderer failure, and cleanup are
  deterministic and tested;
- fixed seeds reproduce the same event schedule and validated result;
- a second dummy module plugs in without changes to the host, runtime, stage,
  or persistence flow;
- disabling the feature fully restores ordinary OpenPets behavior.

## Milestone 5: formal game modules

Implement only enough variety to validate the contract:

1. A response-inhibition task using a generic go/no-go paradigm.
2. A working-memory task using a fixed-capacity continuous-updating paradigm
   with original presentation. Its capacity, update timing, choice generation,
   and difficulty parameters require an approved task-to-game mapping and
   contamination review.

These are demonstrations, not a finalized cognitive curriculum. Parameters and
scoring remain transparent and versioned.

The first level of each task is the rule-learning test: it uses highly
distinguishable stimuli, low pressure, and immediate feedback instead of a
separate tutorial or demonstration sequence. The plugin automatically selects
between the two tasks while avoiding excessive consecutive repetition.

## Milestone 6: local pet loop

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

The next code changes should implement no formal game. First add a feature-
flagged hotspot and anchored sandbox window, then run the task-neutral Stage
Exerciser through the complete runtime lifecycle. The exerciser remains
development-only. Formal game code begins only after the infrastructure gate
passes and must use the approved runtime, stage, and task-module contracts.
