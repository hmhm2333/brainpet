// Golden test for openpets.reminders.
//
// Runs two ways:
//   * `node test.js` (via scripts/test-plugins.mjs) — pure-helper unit checks
//     plus the harness-driven golden test.
//   * authored against `@open-pets/plugin-sdk/testing`; when that bare
//     specifier isn't resolvable from this directory we fall back to the
//     built workspace dist so the test still runs standalone.
import assert from "node:assert/strict";
import {
  cleanMessage,
  durationMs,
  summary,
  register,
  MAX_REMINDERS,
} from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(
    new URL("../../../packages/sdk/dist/testing.js", import.meta.url)
  ));
}

// --- pure helper unit checks --------------------------------------------

assert.equal(cleanMessage("  hello\nthere  "), "hello there");
assert.equal(cleanMessage("", "fallback"), "fallback");
assert.equal(cleanMessage("x".repeat(500)).length, 140);
assert.equal(durationMs({ hours: 1, minutes: 30 }), 90 * 60_000);
assert.equal(durationMs({ minutes: 15 }), 15 * 60_000);
assert.throws(() => durationMs({ hours: 0, minutes: 0 }));
// Out-of-range fields are clamped, not rejected: 25h -> 23h is still valid.
assert.equal(durationMs({ hours: 25, minutes: 0 }), 23 * 60 * 60_000);
assert.equal(summary([]), "No active reminders.");
assert.equal(
  summary([{ id: "a", message: "tea", dueAt: 1_000 + 5 * 60_000 }], 1_000),
  "5 min: tea",
);

// --- golden harness test -------------------------------------------------

const PERMISSIONS = [
  "pet:speak",
  "pet:interact",
  "audio",
  "schedule",
  "storage",
  "commands",
  "status",
  "notify",
];

const LOCALES = {
  en: JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("./locales/en.json", import.meta.url),
      "utf8",
    ),
  ),
};

// 1) Setting a reminder via the form schedules it and stores it.
{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    config: { soundEnabled: true, osNotification: true, customSound: "gong" },
    locales: LOCALES,
    nowMs: 1_000_000,
  });
  await h.start();

  await h.runCommand("set-reminder", { message: "Drink water", hours: 0, minutes: 30 });
  h.expectStored("reminders", (v) => Array.isArray(v) && v.length === 1 && v[0].message === "Drink water");
  h.expectSpoke(/30 min/);
  assert.equal(h.calls.schedules.size, 1, "expected one scheduled reminder");

  // Advancing past the due time fires the acknowledge-pattern delivery.
  await h.clock.advance("31m");
  h.expectBubble({
    indicator: {
      icon: { kind: "icon", name: "reminder" },
      label: "Reminder",
      tone: "info",
      color: "#7c3aed",
      background: "#ede9fe",
      borderColor: "#c4b5fd",
    },
    tone: "info",
    sticky: true,
    priority: "high",
  });
  h.expectBubble({ textMatch: /Drink water/ });
  h.expectNotified(/Drink water/);
  assert.equal(h.calls.alerts.length, 1, "expected ctx.ui.alert delivery");
  assert.ok(h.calls.sounds.some((s) => s.sound === "gong"), "expected the custom alert sound to play");
  // Fired reminder is removed from storage.
  h.expectStored("reminders", (v) => Array.isArray(v) && v.length === 0);
  h.expectNoErrors();
}

// 2) A preset reminder fires and the Snooze action reschedules +5m.
{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    config: { soundEnabled: false, osNotification: false },
    locales: LOCALES,
    nowMs: 2_000_000,
  });
  await h.start();

  await h.runCommand("reminder-15");
  h.expectStored("reminders", (v) => v.length === 1);
  assert.equal(h.calls.sounds.length, 0, "sound disabled — nothing should play");

  await h.clock.advance("16m");
  const bubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  assert.ok(bubble, "expected a delivery bubble");
  assert.deepEqual(
    bubble.spec.actions?.map((a) => a.id),
    ["done", "snooze"],
    "expected Done + Snooze actions",
  );
  assert.equal(h.calls.alerts.length, 1, "preset delivery should use ctx.ui.alert");
  assert.equal(h.calls.notifications.length, 0, "osNotification disabled — no notification");

  // Snooze: reschedules a fresh reminder ~5 minutes out.
  await h.fireBubbleAction(bubble.handle.id, "snooze");
  h.expectStored("reminders", (v) => v.length === 1 && v[0].dueAt > h.clock.now());
  h.expectNoErrors();
}

// 3) view-reminders lists pending items with a per-item cancel.
{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    locales: LOCALES,
    nowMs: 3_000_000,
  });
  await h.start();
  await h.runCommand("reminder-30");
  await h.runCommand("reminder-60");
  await h.runCommand("view-reminders");
  assert.equal(h.calls.menuItems.length, 2, "expected two pending menu items");

  // Selecting an item's cancel removes that reminder.
  await h.calls.menuItems[0].onSelect();
  h.expectStored("reminders", (v) => v.length === 1);
  h.expectNoErrors();
}

// 4) reconcile() on start fires overdue reminders as "missed".
{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    config: { soundEnabled: true, osNotification: true },
    locales: LOCALES,
    nowMs: 4_000_000,
  });
  // Seed storage with an already-overdue reminder before start().
  await h.ctx.storage.set("reminders", [
    { id: "reminder-old", message: "Stand up", dueAt: 4_000_000 - 60_000 },
  ]);
  await h.start();

  h.expectBubble({ textMatch: /Stand up/ });
  h.expectBubble({
    indicator: {
      icon: { kind: "icon", name: "reminder" },
      label: "Missed reminder",
      tone: "warning",
      color: "#d97706",
      background: "#fef3c7",
      borderColor: "#fbbf24",
    },
  });
  h.expectNotified(/Stand up/);
  h.expectStored("reminders", (v) => Array.isArray(v) && v.length === 0);
  h.expectNoErrors();
}

// 5) clear-reminders cancels everything.
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES });
  await h.start();
  await h.runCommand("reminder-15");
  await h.runCommand("clear-reminders");
  h.expectStored("reminders", (v) => Array.isArray(v) && v.length === 0);
  assert.equal(h.calls.schedules.size, 0, "expected no scheduled reminders after clear");
  h.expectSpoke(/cleared/i);
  h.expectNoErrors();
}

// 6) test-reminder previews the alert without storing a reminder.
{
  const h = createTestHarness(register, {
    permissions: PERMISSIONS,
    config: { soundEnabled: false, osNotification: false },
    locales: LOCALES,
    nowMs: 5_000_000,
  });
  await h.start();
  await h.runCommand("test-reminder");
  h.expectBubble({ textMatch: /test reminder/i });
  h.expectBubble({
    indicator: {
      icon: { kind: "icon", name: "reminder" },
      label: "Reminder",
      tone: "info",
      color: "#7c3aed",
      background: "#ede9fe",
      borderColor: "#c4b5fd",
    },
    sticky: true,
    priority: "high",
  });
  h.expectStored("reminders", (v) => Array.isArray(v) && v.length === 0);
  h.expectNoErrors();
}

// 7) MAX_REMINDERS guard.
assert.equal(MAX_REMINDERS, 10);

console.log("openpets.reminders: all checks passed.");
