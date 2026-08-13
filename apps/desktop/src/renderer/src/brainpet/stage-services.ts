export interface StageAssetDeclaration {
  readonly id: string;
  readonly version: string;
  readonly kind: "sprite" | "sound";
  readonly url: string;
  readonly fallback: string;
}

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
}

export interface StageScene {
  readonly id: string;
  readonly camera: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly layers: readonly { readonly id: string; readonly z: number; readonly sprites: readonly StageSprite[] }[];
  readonly particles: readonly { readonly id: string; readonly x: number; readonly y: number; readonly lifetimeMs: number }[];
}

export class StageAssetRegistry {
  private readonly cache = new Map<string, StageAssetStatus>();

  async preload(manifest: readonly StageAssetDeclaration[], load: (url: string) => Promise<void>): Promise<readonly StageAssetStatus[]> {
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
        await load(declaration.url);
      } catch {
        loaded = false;
        resolvedUrl = declaration.fallback;
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
  const layerIds = new Set<string>();
  for (const layer of scene.layers) {
    if (!layer.id || layerIds.has(layer.id) || !Number.isFinite(layer.z)) throw new Error("Invalid BrainPet scene layer.");
    layerIds.add(layer.id);
    for (const sprite of layer.sprites) {
      if (!sprite.id || !sprite.assetId || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y) || !Number.isInteger(sprite.frame) || sprite.frame < 0) throw new Error("Invalid BrainPet scene sprite.");
    }
  }
  for (const particle of scene.particles) {
    if (!particle.id || !Number.isFinite(particle.x) || !Number.isFinite(particle.y) || !Number.isFinite(particle.lifetimeMs) || particle.lifetimeMs < 0) throw new Error("Invalid BrainPet scene particle.");
  }
  return scene;
}
