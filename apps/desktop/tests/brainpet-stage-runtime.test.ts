import assert from "node:assert/strict";
import test from "node:test";

import { LogicalSessionClock, StageQualityMonitor, loadStageSettings, saveStageSettings } from "../src/renderer/src/brainpet/stage-runtime.js";

test("logical clock removes every pause interval from task time", () => {
  const clock = new LogicalSessionClock();
  assert.equal(clock.now(100), 100);
  assert.equal(clock.pause(120), true);
  assert.equal(clock.now(5_120), 120);
  assert.equal(clock.resume(5_120), true);
  assert.equal(clock.now(5_200), 200);
  assert.equal(clock.pausedDuration(5_200), 5_000);
});

test("quality monitor records long frames and focus loss", () => {
  const monitor = new StageQualityMonitor();
  monitor.frame(0);
  monitor.frame(16.7);
  monitor.frame(150);
  monitor.focusLost();
  const result = monitor.snapshot(2_000);
  assert.equal(result.focusLossCount, 1);
  assert.equal(result.longFrameCount, 1);
  assert.equal(result.droppedFrameCount > 0, true);
  assert.deepEqual(result.flags, ["focus-lost", "long-frame"]);
});

test("a paused interval is not misclassified as dropped frames", () => {
  const monitor = new StageQualityMonitor();
  monitor.frame(0);
  monitor.frame(16.7);
  monitor.resetFrameAnchor();
  monitor.frame(30_000);
  monitor.frame(30_016.7);
  assert.equal(monitor.snapshot(29_983.3).droppedFrameCount, 0);
});

test("the declared 30 fps fallback is not classified as frame loss", () => {
  const monitor = new StageQualityMonitor();
  for (let frame = 0; frame < 1_350; frame += 1) monitor.frame(frame * 33.4);
  const result = monitor.snapshot(0);
  assert.equal(result.droppedFrameCount, 0);
  assert.equal(result.valid, true);
});

test("sustained cadence below the 30 fps floor invalidates quality", () => {
  const monitor = new StageQualityMonitor();
  for (let frame = 0; frame < 180; frame += 1) monitor.frame(frame * 100);
  const result = monitor.snapshot(0);
  assert.equal(result.valid, false);
  assert.equal(result.flags.includes("excessive-frame-loss"), true);
});

test("a stable 20 fps cadence cannot pass the declared 30 fps floor", () => {
  const monitor = new StageQualityMonitor();
  for (let now = 0; now <= 6_000; now += 50) monitor.frame(now);
  const snapshot = monitor.snapshot(0);
  assert.equal(snapshot.valid, false);
  assert.ok(snapshot.droppedFrameCount > 0);
  assert.ok(snapshot.flags.includes("excessive-frame-loss"));
});

test("stage accessibility settings round-trip without expanding host IPC", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  saveStageSettings(storage, { soundEnabled: false, reducedMotion: true, highContrast: true });
  assert.deepEqual(loadStageSettings(storage), { soundEnabled: false, reducedMotion: true, highContrast: true });
});
