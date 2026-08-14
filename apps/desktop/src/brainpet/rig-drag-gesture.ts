export interface BrainPetRigPointer {
  readonly screenX: number;
  readonly screenY: number;
}

export const BRAINPET_RIG_DRAG_THRESHOLD_PX = 6;

export function hasBrainPetRigDragStarted(
  start: BrainPetRigPointer,
  current: BrainPetRigPointer,
  thresholdPx = BRAINPET_RIG_DRAG_THRESHOLD_PX,
): boolean {
  if (!isFinitePoint(start) || !isFinitePoint(current) || !Number.isFinite(thresholdPx) || thresholdPx < 0) return false;
  return Math.hypot(current.screenX - start.screenX, current.screenY - start.screenY) > thresholdPx;
}

export function isBrainPetRigPointer(value: unknown): value is BrainPetRigPointer {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Partial<BrainPetRigPointer>;
  return typeof point.screenX === "number" && Number.isFinite(point.screenX)
    && typeof point.screenY === "number" && Number.isFinite(point.screenY);
}

function isFinitePoint(point: BrainPetRigPointer): boolean {
  return Number.isFinite(point.screenX) && Number.isFinite(point.screenY);
}
