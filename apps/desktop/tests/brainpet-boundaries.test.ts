import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const host = readFileSync(resolve("src/brainpet/host.ts"), "utf8");
const runtime = readFileSync(resolve("src/brainpet/runtime-core.ts"), "utf8");
const stage = readFileSync(resolve("src/renderer/src/brainpet/main.ts"), "utf8");

test("Host and Runtime contain no formal game ids, titles or scoring weights", () => {
  for (const source of [host, runtime]) {
    assert.doesNotMatch(source, /cargo-signal|pack-refresh|装箱，还是放过|行囊不重样|correctPoints|incorrectPoints/);
  }
});

test("Stage renderer contains no formal game ids or task scoring branches", () => {
  assert.doesNotMatch(stage, /cargo-signal|pack-refresh|correctPoints|incorrectPoints/);
});
