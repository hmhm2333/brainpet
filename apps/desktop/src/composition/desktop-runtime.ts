import type { DesktopComposition, DesktopCompositionLayer } from "./desktop-composition.js";
import { DesktopServiceLifecycle, type DesktopServiceFactory } from "./managed-service.js";

export type DesktopRuntimeFactories = Readonly<Record<DesktopCompositionLayer, DesktopServiceFactory>>;

export function createDesktopRuntime(
  composition: DesktopComposition,
  factories: DesktopRuntimeFactories,
): DesktopServiceLifecycle {
  return new DesktopServiceLifecycle(composition.layers.map((layer) => factories[layer]));
}
