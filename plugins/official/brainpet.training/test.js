import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { TRAINING_OPEN_TOPIC, register } from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(new URL("../../../packages/sdk/dist/testing.js", import.meta.url)));
}

const locales = { en: JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8")) };
const harness = createTestHarness(register, { permissions: ["commands", "bus"], locales });

await harness.start();
assert.equal(harness.calls.commands.get("train")?.meta.featured, true);
assert.equal(harness.calls.commands.get("train")?.meta.placement, "top");

await harness.runCommand("train");
assert.deepEqual(harness.calls.busPublishes, [{ topic: TRAINING_OPEN_TOPIC, payload: { source: "pet-command" } }]);
harness.expectNoErrors();

console.log("brainpet.training: all checks passed.");
