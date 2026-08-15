import assert from "node:assert/strict";
import test from "node:test";

import { startPluginPlatformTransaction, type PluginPlatformStartupSteps } from "../src/composition/plugin-platform-startup.js";

type Service = { readonly attempt: number };
type Capabilities = { readonly attempt: number };
type Watcher = { readonly attempt: number };
type FailurePoint = "service" | "sources" | "resume" | "tray" | "ready" | null;

function fixture() {
  let attempt = 0;
  let failure: FailurePoint = null;
  let cleanupFailure: "watcher" | null = null;
  let singleton: Service | null = null;
  const active = { listeners: 0, service: 0, watcher: 0, resume: 0, tray: 0 };
  const cleanupOrder: string[] = [];
  const cleanupErrors: unknown[] = [];

  const steps = (): PluginPlatformStartupSteps<Service, Capabilities, Watcher> => ({
    assertActive() {
      if (failure === "ready" && active.tray > 0) throw new Error("ready failed");
    },
    createCapabilities() {
      attempt += 1;
      active.listeners += 9;
      return { attempt };
    },
    disposeCapabilities() {
      cleanupOrder.push("capabilities");
      active.listeners -= 9;
    },
    createService() {
      const service = { attempt };
      singleton = service;
      active.service += 1;
      return service;
    },
    async startService() {
      if (failure === "service") throw new Error("service failed");
    },
    stopService(service) {
      cleanupOrder.push("service");
      active.service -= 1;
      if (singleton === service) singleton = null;
    },
    async loadSources() {
      if (failure === "sources") throw new Error("sources failed");
    },
    createWatcher() {
      active.watcher += 1;
      return { attempt };
    },
    stopWatcher() {
      cleanupOrder.push("watcher");
      active.watcher -= 1;
      if (cleanupFailure === "watcher") throw new Error("watcher cleanup failed");
    },
    installResumeListener() {
      if (failure === "resume") throw new Error("resume failed");
      active.resume += 1;
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        cleanupOrder.push("resume");
        active.resume -= 1;
      };
    },
    async installTrayMenu() {
      if (failure === "tray") throw new Error("tray failed");
      active.tray += 1;
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        cleanupOrder.push("tray");
        active.tray -= 1;
      };
    },
    onCleanupError(error) { cleanupErrors.push(error); },
  });

  return {
    active,
    cleanupOrder,
    cleanupErrors,
    get singleton() { return singleton; },
    setFailure(value: FailurePoint) { failure = value; },
    setCleanupFailure(value: "watcher" | null) { cleanupFailure = value; },
    steps,
  };
}

test("the actual plugin startup orchestration rolls every failure point back to baseline", async () => {
  for (const failure of ["service", "sources", "resume", "tray", "ready"] as const) {
    const state = fixture();
    state.setFailure(failure);
    await assert.rejects(startPluginPlatformTransaction(state.steps()), new RegExp(`${failure} failed`));
    assert.deepEqual(state.active, { listeners: 0, service: 0, watcher: 0, resume: 0, tray: 0 }, failure);
    assert.equal(state.singleton, null, failure);
  }
});

test("cleanup failure cannot mask the startup error or stop later cleanup", async () => {
  const state = fixture();
  state.setFailure("ready");
  state.setCleanupFailure("watcher");
  await assert.rejects(startPluginPlatformTransaction(state.steps()), /ready failed/);
  assert.deepEqual(state.active, { listeners: 0, service: 0, watcher: 0, resume: 0, tray: 0 });
  assert.equal(state.singleton, null);
  assert.equal(state.cleanupErrors.length, 1);
  assert.deepEqual(state.cleanupOrder, ["tray", "resume", "watcher", "service", "capabilities"]);
});

test("a failed attempt can retry and final disposal removes the one committed resource set", async () => {
  const state = fixture();
  state.setFailure("ready");
  await assert.rejects(startPluginPlatformTransaction(state.steps()), /ready failed/);
  state.setFailure(null);
  const resources = await startPluginPlatformTransaction(state.steps());
  assert.deepEqual(state.active, { listeners: 9, service: 1, watcher: 1, resume: 1, tray: 1 });
  assert.equal(state.singleton, resources.service);

  resources.removeTrayMenu();
  resources.removeResumeListener();
  state.steps().stopWatcher(resources.watcher!);
  await state.steps().stopService(resources.service);
  await state.steps().disposeCapabilities(resources.capabilities);
  assert.deepEqual(state.active, { listeners: 0, service: 0, watcher: 0, resume: 0, tray: 0 });
  assert.equal(state.singleton, null);
});
