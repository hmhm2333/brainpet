export interface BrainPetRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrainPetSize {
  readonly width: number;
  readonly height: number;
}

const TARGET_ASPECT_RATIO = 16 / 9;
const DEFAULT_MIN_WIDTH = 480;
const DEFAULT_MAX_WIDTH = 720;
const DEFAULT_TARGET_WIDTH = 640;
const PET_GAP = 12;
const WORK_AREA_MARGIN = 12;

export function computeBrainPetStageSize(
  workArea: BrainPetRectangle,
  targetWidth = DEFAULT_TARGET_WIDTH,
): BrainPetSize {
  const maxWidthForArea = Math.max(320, workArea.width - WORK_AREA_MARGIN * 2);
  const maxHeightForArea = Math.max(180, workArea.height - WORK_AREA_MARGIN * 2);
  const maxWidthFromHeight = Math.floor(maxHeightForArea * TARGET_ASPECT_RATIO);
  const availableWidth = Math.min(maxWidthForArea, maxWidthFromHeight);
  const preferredWidth = Math.min(DEFAULT_MAX_WIDTH, Math.max(DEFAULT_MIN_WIDTH, targetWidth));
  const width = Math.max(320, Math.min(preferredWidth, availableWidth));
  return { width, height: Math.round(width / TARGET_ASPECT_RATIO) };
}

export function computeBrainPetStageBounds(
  petBounds: BrainPetRectangle,
  workArea: BrainPetRectangle,
  stageSize = computeBrainPetStageSize(workArea),
): BrainPetRectangle {
  const minX = workArea.x + WORK_AREA_MARGIN;
  const maxX = workArea.x + workArea.width - stageSize.width - WORK_AREA_MARGIN;
  const minY = workArea.y + WORK_AREA_MARGIN;
  const maxY = workArea.y + workArea.height - stageSize.height - WORK_AREA_MARGIN;

  const petCenter = { x: petBounds.x + petBounds.width / 2, y: petBounds.y + petBounds.height / 2 };
  const workCenter = { x: workArea.x + workArea.width / 2, y: workArea.y + workArea.height / 2 };
  const towardCenter = { x: workCenter.x - petCenter.x, y: workCenter.y - petCenter.y };
  const centeredX = Math.round(petCenter.x - stageSize.width / 2);
  const centeredY = Math.round(petCenter.y - stageSize.height / 2);
  const candidates = [
    { direction: { x: -1, y: 0 }, bounds: { x: petBounds.x - stageSize.width - PET_GAP, y: clamp(centeredY, minY, Math.max(minY, maxY)), width: stageSize.width, height: stageSize.height } },
    { direction: { x: 1, y: 0 }, bounds: { x: petBounds.x + petBounds.width + PET_GAP, y: clamp(centeredY, minY, Math.max(minY, maxY)), width: stageSize.width, height: stageSize.height } },
    { direction: { x: 0, y: -1 }, bounds: { x: clamp(centeredX, minX, Math.max(minX, maxX)), y: petBounds.y - stageSize.height - PET_GAP, width: stageSize.width, height: stageSize.height } },
    { direction: { x: 0, y: 1 }, bounds: { x: clamp(centeredX, minX, Math.max(minX, maxX)), y: petBounds.y + petBounds.height + PET_GAP, width: stageSize.width, height: stageSize.height } },
  ].filter((candidate) => candidate.bounds.x >= minX && candidate.bounds.x <= maxX && candidate.bounds.y >= minY && candidate.bounds.y <= maxY)
    .sort((left, right) => right.direction.x * towardCenter.x + right.direction.y * towardCenter.y - (left.direction.x * towardCenter.x + left.direction.y * towardCenter.y));
  const preferred = candidates[0]?.bounds;
  if (preferred) return preferred;
  return { x: clamp(centeredX, minX, Math.max(minX, maxX)), y: clamp(petBounds.y - stageSize.height - PET_GAP, minY, Math.max(minY, maxY)), width: stageSize.width, height: stageSize.height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
