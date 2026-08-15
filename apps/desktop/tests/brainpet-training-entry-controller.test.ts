import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow } from "electron";

import { BrainPetTrainingEntry, type BrainPetTrainingRequestHandler } from "../src/brainpet/training-entry.js";

test("TrainingEntry registers once, toggles the built-in stage, and disposes once", () => {
  let handler: BrainPetTrainingRequestHandler | null = null;
  let open = false;
  const events: string[] = [];
  const entry = new BrainPetTrainingEntry({
    register(next) { handler = next; events.push(next ? "register" : "unregister"); },
    open() { open = true; events.push("open"); },
    close(reason) { open = false; events.push(`close:${reason}`); },
    isOpen: () => open,
  });
  const source = {} as BrowserWindow;

  entry.start();
  entry.start();
  assert.ok(handler);
  (handler as BrainPetTrainingRequestHandler)(source);
  (handler as BrainPetTrainingRequestHandler)(source);
  entry.dispose();
  entry.dispose();

  assert.deepEqual(events, ["register", "open", "close:built-in-training-entry", "unregister"]);
});
