import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const petWindow = readFileSync(resolve("src/pet-window.ts"), "utf8");
const stageCss = readFileSync(resolve("src/renderer/src/brainpet/stage.css"), "utf8");
const stageMain = readFileSync(resolve("src/renderer/src/brainpet/main.ts"), "utf8");

test("pet accessory and stage share the frozen V1 palette and pixel treatment", () => {
  for (const token of ["#17243b", "#f5bd3d", "#d9952f"]) {
    assert.match(petWindow, new RegExp(token));
    assert.match(stageCss, new RegExp(token));
  }
  assert.match(petWindow, /brainpet-trigger[\s\S]*width: 30px; height: 30px/);
  assert.match(petWindow, /image-rendering: pixelated/);
  assert.match(stageCss, /image-rendering: pixelated/);
});

test("V1 visual and sound states have explicit production behavior", () => {
  assert.match(petWindow, /brainpet-toss 480ms/);
  for (const state of ["clear", "streak", "new-best"]) assert.match(petWindow, new RegExp(`brainpet-feedback="${state}"`));
  assert.match(stageMain, /default-pet-spritesheet\.webp/);
  for (const sound of ["start", "correct", "incorrect", "finish"]) assert.match(stageMain, new RegExp(`${sound}:`));
  assert.doesNotMatch(stageMain, /placeholder|lorem ipsum/i);
});
