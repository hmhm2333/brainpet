import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { registerPluginSystemEventListeners, type PluginEventListener, type PluginSystemEventHandlers } from "../src/plugin-event-listeners.js";

class InjectedEmitter extends EventEmitter {
  public registrations = 0;
  public failAfter: number | null = null;

  public override on(event: string, listener: PluginEventListener): this {
    super.on(event, listener);
    this.registrations += 1;
    if (this.failAfter === this.registrations) throw new Error("injected listener failure");
    return this;
  }
}

const eventNames = ["lock-screen", "unlock-screen", "on-battery", "on-ac", "suspend", "resume", "display-added", "display-removed", "display-metrics-changed"] as const;

function handlers(events: string[]): PluginSystemEventHandlers {
  return {
    lockScreen: () => events.push("lock"),
    unlockScreen: () => events.push("unlock"),
    onBattery: () => events.push("battery"),
    onAc: () => events.push("ac"),
    suspend: () => events.push("suspend"),
    resume: () => events.push("resume"),
    displayChanged: () => events.push("display"),
  };
}

function totalListeners(power: EventEmitter, screen: EventEmitter): number {
  return eventNames.reduce((count, event) => count + power.listenerCount(event) + screen.listenerCount(event), 0);
}

test("partial listener registration failure removes every listener before retry", () => {
  const power = new InjectedEmitter();
  const screen = new InjectedEmitter();
  power.failAfter = 4;
  assert.throws(() => registerPluginSystemEventListeners(power, screen, handlers([])), /injected listener failure/);
  assert.equal(totalListeners(power, screen), 0);

  power.failAfter = null;
  const events: string[] = [];
  const dispose = registerPluginSystemEventListeners(power, screen, handlers(events));
  assert.equal(totalListeners(power, screen), 9);
  power.emit("lock-screen");
  screen.emit("display-added");
  assert.deepEqual(events, ["lock", "display"]);
  dispose();
  dispose();
  assert.equal(totalListeners(power, screen), 0);
});

test("cleanup attempts every off operation even when one removal fails", () => {
  const power = new InjectedEmitter();
  const screen = new InjectedEmitter();
  const dispose = registerPluginSystemEventListeners(power, screen, handlers([]));
  const originalOff = power.off.bind(power);
  let injected = false;
  power.off = ((event: string, listener: PluginEventListener) => {
    originalOff(event, listener);
    if (!injected) { injected = true; throw new Error("injected cleanup failure"); }
    return power;
  }) as typeof power.off;
  assert.throws(dispose, /injected cleanup failure/);
  assert.equal(totalListeners(power, screen), 0);
});
