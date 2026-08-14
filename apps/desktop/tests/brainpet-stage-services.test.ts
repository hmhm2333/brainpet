import assert from "node:assert/strict";
import test from "node:test";

import { StageAssetRegistry, validateStageScene } from "../src/renderer/src/brainpet/stage-services.js";

test("asset registry caches versioned assets and safely falls back when one is missing", async () => {
  const registry = new StageAssetRegistry();
  let loads = 0;
  const manifest = [{ id: "pet", version: "1.0.0", kind: "sprite" as const, url: "pet.png", fallback: "pixel:B" }];
  const first = await registry.preload(manifest, async (url) => { loads += 1; if (url === "pet.png") throw new Error("missing"); });
  const second = await registry.preload(manifest, async () => { loads += 1; });
  assert.equal(first[0]?.loaded, false);
  assert.equal(first[0]?.resolvedUrl, "pixel:B");
  assert.equal(second[0]?.resolvedUrl, "pixel:B");
  assert.equal(loads, 2);
});

test("scene contract provides task-neutral layers, reaction surfaces, varied rig projectiles, particles and camera", () => {
  const scene = validateStageScene({ id: "exercise", camera: { x: 0, y: 0, zoom: 1 }, reactionInput: "primary", layers: [{ id: "actors", z: 10, sprites: [{ id: "pet", assetId: "pet", x: 32, y: 24, frame: 0 }] }], rigProjectiles: [{ id: "parcel", assetId: "parcel", progress: 0.25, arcHeightPx: 120, curveOffsetPx: -52, spinTurns: 1, input: "primary" }], particles: [{ id: "spark", x: 32, y: 24, lifetimeMs: 300 }] });
  assert.equal(scene.layers[0]?.sprites[0]?.assetId, "pet");
  assert.equal(scene.reactionInput, "primary");
  assert.equal(scene.rigProjectiles?.[0]?.progress, 0.25);
  assert.throws(() => validateStageScene({ ...scene, camera: { x: 0, y: 0, zoom: 0 } }), /camera/);
  assert.throws(() => validateStageScene({ ...scene, rigProjectiles: [{ id: "parcel", assetId: "parcel", progress: 1.1, arcHeightPx: 120, input: "primary" }] }), /projectile/);
  assert.throws(() => validateStageScene({ ...scene, reactionInput: "moving-target" as "primary" }), /reaction input/);
});
