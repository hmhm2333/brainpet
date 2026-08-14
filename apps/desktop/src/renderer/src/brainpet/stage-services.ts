import type { BrainPetTaskAssetDeclaration as StageAssetDeclaration } from "../../../brainpet/task-contract.js";

export type { BrainPetTaskAssetDeclaration as StageAssetDeclaration } from "../../../brainpet/task-contract.js";

export interface StageAssetStatus extends StageAssetDeclaration {
  readonly loaded: boolean;
  readonly resolvedUrl: string;
  readonly loadMs: number;
}

export interface StageSprite {
  readonly id: string;
  readonly assetId: string;
  readonly x: number;
  readonly y: number;
  readonly frame: number;
  readonly text?: string;
  readonly ariaLabel?: string;
  readonly input?: "primary" | "secondary";
}

export interface StageRigProjectile {
  readonly id: string;
  readonly assetId: string;
  readonly progress: number;
  readonly arcHeightPx: number;
  readonly curveOffsetPx?: number;
  readonly spinTurns?: number;
  readonly ariaLabel?: string;
  readonly input?: "primary" | "secondary";
}

export interface StageScene {
  readonly id: string;
  readonly camera: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly layers: readonly { readonly id: string; readonly z: number; readonly sprites: readonly StageSprite[] }[];
  readonly particles: readonly { readonly id: string; readonly x: number; readonly y: number; readonly lifetimeMs: number }[];
  readonly rigProjectiles?: readonly StageRigProjectile[];
  readonly reactionInput?: "primary" | "secondary";
}

export class StageAssetRegistry {
  private readonly cache = new Map<string, StageAssetStatus>();

  async preload(manifest: readonly StageAssetDeclaration[], load: (url: string, declaration: StageAssetDeclaration) => Promise<void>): Promise<readonly StageAssetStatus[]> {
    const results: StageAssetStatus[] = [];
    for (const declaration of manifest) {
      const key = `${declaration.id}@${declaration.version}`;
      const cached = this.cache.get(key);
      if (cached) {
        results.push(cached);
        continue;
      }
      const startedAt = performance.now();
      let loaded = true;
      let resolvedUrl = declaration.url;
      try {
        await load(declaration.url, declaration);
      } catch {
        loaded = false;
        resolvedUrl = declaration.fallback;
        await load(declaration.fallback, declaration);
      }
      const status = { ...declaration, loaded, resolvedUrl, loadMs: Math.max(0, performance.now() - startedAt) };
      this.cache.set(key, status);
      results.push(status);
    }
    return results;
  }

  clear(): void {
    this.cache.clear();
  }
}

export function validateStageScene(scene: StageScene): StageScene {
  if (!scene.id || !Number.isFinite(scene.camera.x) || !Number.isFinite(scene.camera.y) || !Number.isFinite(scene.camera.zoom) || scene.camera.zoom <= 0) throw new Error("Invalid BrainPet scene camera.");
  if (scene.reactionInput !== undefined && scene.reactionInput !== "primary" && scene.reactionInput !== "secondary") throw new Error("Invalid BrainPet scene reaction input.");
  const layerIds = new Set<string>();
  for (const layer of scene.layers) {
    if (!layer.id || layerIds.has(layer.id) || !Number.isFinite(layer.z)) throw new Error("Invalid BrainPet scene layer.");
    layerIds.add(layer.id);
    for (const sprite of layer.sprites) {
      if (!sprite.id || !sprite.assetId || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y) || !Number.isInteger(sprite.frame) || sprite.frame < 0 || (sprite.text !== undefined && (typeof sprite.text !== "string" || sprite.text.length > 32)) || (sprite.ariaLabel !== undefined && (typeof sprite.ariaLabel !== "string" || sprite.ariaLabel.trim().length === 0 || sprite.ariaLabel.length > 64)) || (sprite.input !== undefined && sprite.input !== "primary" && sprite.input !== "secondary")) throw new Error("Invalid BrainPet scene sprite.");
    }
  }
  for (const particle of scene.particles) {
    if (!particle.id || !Number.isFinite(particle.x) || !Number.isFinite(particle.y) || !Number.isFinite(particle.lifetimeMs) || particle.lifetimeMs < 0) throw new Error("Invalid BrainPet scene particle.");
  }
  if (scene.rigProjectiles !== undefined) {
    if (!Array.isArray(scene.rigProjectiles) || scene.rigProjectiles.length > 16) throw new Error("Invalid BrainPet rig projectiles.");
    const projectileIds = new Set<string>();
    for (const projectile of scene.rigProjectiles) {
      if (!projectile.id || projectileIds.has(projectile.id) || !projectile.assetId || !Number.isFinite(projectile.progress) || projectile.progress < 0 || projectile.progress > 1 || !Number.isFinite(projectile.arcHeightPx) || projectile.arcHeightPx < 0 || projectile.arcHeightPx > 800 || (projectile.curveOffsetPx !== undefined && (!Number.isFinite(projectile.curveOffsetPx) || Math.abs(projectile.curveOffsetPx) > 240)) || (projectile.spinTurns !== undefined && (!Number.isFinite(projectile.spinTurns) || Math.abs(projectile.spinTurns) > 3)) || (projectile.ariaLabel !== undefined && (typeof projectile.ariaLabel !== "string" || projectile.ariaLabel.trim().length === 0 || projectile.ariaLabel.length > 64)) || (projectile.input !== undefined && projectile.input !== "primary" && projectile.input !== "secondary")) throw new Error("Invalid BrainPet rig projectile.");
      projectileIds.add(projectile.id);
    }
  }
  return scene;
}
