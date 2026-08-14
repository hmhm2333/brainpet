import { computeBrainPetStageBounds, computeBrainPetStageSize, type BrainPetRectangle } from "./geometry.js";

export interface BrainPetPoint {
  readonly x: number;
  readonly y: number;
}

export interface BrainPetRigEnvironment {
  readonly displayId: string;
  readonly scaleFactor: number;
  readonly workArea: BrainPetRectangle;
}

export interface BrainPetInteractionRigSnapshot {
  readonly apiVersion: 1;
  readonly rigId: string;
  readonly petWindowId: number;
  readonly petBoundsScreen: BrainPetRectangle;
  readonly stageBoundsScreen: BrainPetRectangle;
  readonly overlayBoundsScreen: BrainPetRectangle;
  readonly reactionBoundsScreen: BrainPetRectangle;
  readonly throwOriginScreen: BrainPetPoint;
  readonly throwOriginOverlay: BrainPetPoint;
  readonly displayId: string;
  readonly scaleFactor: number;
  readonly dragging: boolean;
  readonly sequence: number;
  readonly atMs: number;
}

export interface CreateBrainPetInteractionRigOptions {
  readonly rigId: string;
  readonly petWindowId: number;
  readonly petBounds: BrainPetRectangle;
  readonly environment: BrainPetRigEnvironment;
  readonly sequence?: number;
  readonly atMs?: number;
}

const REACTION_SIZE = 180;
const OVERLAY_MARGIN = 16;
export const BRAINPET_STAGE_MAX_GAP_PX = 32;

export function createBrainPetInteractionRig(options: CreateBrainPetInteractionRigOptions): BrainPetInteractionRigSnapshot {
  const stageSize = computeBrainPetStageSize(options.environment.workArea);
  const stageBounds = computeBrainPetStageBounds(options.petBounds, options.environment.workArea, stageSize);
  return buildSnapshot({
    rigId: options.rigId,
    petWindowId: options.petWindowId,
    petBounds: options.petBounds,
    stageBounds,
    environment: options.environment,
    dragging: false,
    sequence: options.sequence ?? 1,
    atMs: options.atMs ?? 0,
  });
}

export function translateBrainPetStageInRig(
  snapshot: BrainPetInteractionRigSnapshot,
  delta: BrainPetPoint,
  environment: BrainPetRigEnvironment,
  options: { readonly dragging?: boolean; readonly sequence?: number; readonly atMs?: number } = {},
): BrainPetInteractionRigSnapshot {
  const clampedDelta = clampTranslationToWorkArea(snapshot.stageBoundsScreen, delta, environment.workArea);
  const desiredStage = translateRectangle(snapshot.stageBoundsScreen, clampedDelta);
  return buildSnapshot({
    rigId: snapshot.rigId,
    petWindowId: snapshot.petWindowId,
    petBounds: snapshot.petBoundsScreen,
    stageBounds: constrainStageToPetRange(desiredStage, snapshot.petBoundsScreen, environment.workArea),
    environment,
    dragging: options.dragging ?? snapshot.dragging,
    sequence: options.sequence ?? snapshot.sequence + 1,
    atMs: options.atMs ?? snapshot.atMs,
  });
}

export function reanchorBrainPetInteractionRig(
  snapshot: BrainPetInteractionRigSnapshot,
  petBounds: BrainPetRectangle,
  environment: BrainPetRigEnvironment,
  options: { readonly dragging?: boolean; readonly sequence?: number; readonly atMs?: number } = {},
): BrainPetInteractionRigSnapshot {
  const stageCorrection = clampTranslationToWorkArea(snapshot.stageBoundsScreen, { x: 0, y: 0 }, environment.workArea);
  const desiredStage = translateRectangle(snapshot.stageBoundsScreen, stageCorrection);
  return buildSnapshot({
    rigId: snapshot.rigId,
    petWindowId: snapshot.petWindowId,
    petBounds,
    stageBounds: constrainStageToPetRange(desiredStage, petBounds, environment.workArea),
    environment,
    dragging: options.dragging ?? snapshot.dragging,
    sequence: options.sequence ?? snapshot.sequence + 1,
    atMs: options.atMs ?? snapshot.atMs,
  });
}

export function reflowBrainPetInteractionRig(
  snapshot: BrainPetInteractionRigSnapshot,
  petBounds: BrainPetRectangle,
  environment: BrainPetRigEnvironment,
  options: { readonly dragging?: boolean; readonly sequence?: number; readonly atMs?: number } = {},
): BrainPetInteractionRigSnapshot {
  const next = createBrainPetInteractionRig({
    rigId: snapshot.rigId,
    petWindowId: snapshot.petWindowId,
    petBounds,
    environment,
    sequence: options.sequence ?? snapshot.sequence + 1,
    atMs: options.atMs ?? snapshot.atMs,
  });
  return options.dragging === undefined ? next : { ...next, dragging: options.dragging };
}

export function setBrainPetInteractionRigDragging(
  snapshot: BrainPetInteractionRigSnapshot,
  dragging: boolean,
  sequence = snapshot.sequence + 1,
  atMs = snapshot.atMs,
): BrainPetInteractionRigSnapshot {
  return { ...snapshot, dragging, sequence, atMs };
}

export function brainPetRigLocalStageBounds(snapshot: BrainPetInteractionRigSnapshot): BrainPetRectangle {
  return {
    x: snapshot.stageBoundsScreen.x - snapshot.overlayBoundsScreen.x,
    y: snapshot.stageBoundsScreen.y - snapshot.overlayBoundsScreen.y,
    width: snapshot.stageBoundsScreen.width,
    height: snapshot.stageBoundsScreen.height,
  };
}

export function isBrainPetPointInsideRectangle(
  point: BrainPetPoint,
  rectangle: BrainPetRectangle,
  hitSlop = 0,
): boolean {
  const slop = Math.max(0, hitSlop);
  return point.x >= rectangle.x - slop
    && point.x < rectangle.x + rectangle.width + slop
    && point.y >= rectangle.y - slop
    && point.y < rectangle.y + rectangle.height + slop;
}

function buildSnapshot(options: {
  readonly rigId: string;
  readonly petWindowId: number;
  readonly petBounds: BrainPetRectangle;
  readonly stageBounds: BrainPetRectangle;
  readonly environment: BrainPetRigEnvironment;
  readonly dragging: boolean;
  readonly sequence: number;
  readonly atMs: number;
}): BrainPetInteractionRigSnapshot {
  const overlayBounds = expandWithinWorkArea(unionRectangles(options.petBounds, options.stageBounds), OVERLAY_MARGIN, options.environment.workArea);
  const reactionSize = Math.min(REACTION_SIZE, options.stageBounds.width, options.stageBounds.height);
  const reactionBounds = {
    x: Math.round(options.stageBounds.x + (options.stageBounds.width - reactionSize) / 2),
    y: Math.round(options.stageBounds.y + (options.stageBounds.height - reactionSize) / 2),
    width: reactionSize,
    height: reactionSize,
  };
  const throwOrigin = {
    x: Math.round(options.petBounds.x + options.petBounds.width * 0.5),
    y: Math.round(options.petBounds.y + options.petBounds.height * 0.3),
  };
  return {
    apiVersion: 1,
    rigId: options.rigId,
    petWindowId: options.petWindowId,
    petBoundsScreen: roundRectangle(options.petBounds),
    stageBoundsScreen: roundRectangle(options.stageBounds),
    overlayBoundsScreen: overlayBounds,
    reactionBoundsScreen: reactionBounds,
    throwOriginScreen: throwOrigin,
    throwOriginOverlay: {
      x: throwOrigin.x - overlayBounds.x,
      y: throwOrigin.y - overlayBounds.y,
    },
    displayId: options.environment.displayId,
    scaleFactor: options.environment.scaleFactor,
    dragging: options.dragging,
    sequence: options.sequence,
    atMs: options.atMs,
  };
}

function clampTranslationToWorkArea(rectangle: BrainPetRectangle, delta: BrainPetPoint, workArea: BrainPetRectangle): BrainPetPoint {
  const minX = workArea.x - rectangle.x;
  const maxX = workArea.x + workArea.width - (rectangle.x + rectangle.width);
  const minY = workArea.y - rectangle.y;
  const maxY = workArea.y + workArea.height - (rectangle.y + rectangle.height);
  return {
    x: clamp(delta.x, Math.min(minX, maxX), Math.max(minX, maxX)),
    y: clamp(delta.y, Math.min(minY, maxY), Math.max(minY, maxY)),
  };
}

function constrainStageToPetRange(stageBounds: BrainPetRectangle, petBounds: BrainPetRectangle, workArea: BrainPetRectangle): BrainPetRectangle {
  if (rectangleGap(stageBounds, petBounds) <= BRAINPET_STAGE_MAX_GAP_PX) return stageBounds;
  const petCenter = { x: petBounds.x + petBounds.width / 2, y: petBounds.y + petBounds.height / 2 };
  const stageCenter = { x: stageBounds.x + stageBounds.width / 2, y: stageBounds.y + stageBounds.height / 2 };
  const vector = { x: stageCenter.x - petCenter.x, y: stageCenter.y - petCenter.y };
  let inside = 0;
  let outside = 1;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const scale = (inside + outside) / 2;
    const candidate = { ...stageBounds, x: petCenter.x + vector.x * scale - stageBounds.width / 2, y: petCenter.y + vector.y * scale - stageBounds.height / 2 };
    if (rectangleGap(candidate, petBounds) <= BRAINPET_STAGE_MAX_GAP_PX) inside = scale;
    else outside = scale;
  }
  const constrained = { ...stageBounds, x: Math.round(petCenter.x + vector.x * inside - stageBounds.width / 2), y: Math.round(petCenter.y + vector.y * inside - stageBounds.height / 2) };
  return translateRectangle(constrained, clampTranslationToWorkArea(constrained, { x: 0, y: 0 }, workArea));
}

function rectangleGap(left: BrainPetRectangle, right: BrainPetRectangle): number {
  const dx = Math.max(left.x - (right.x + right.width), right.x - (left.x + left.width), 0);
  const dy = Math.max(left.y - (right.y + right.height), right.y - (left.y + left.height), 0);
  return Math.hypot(dx, dy);
}

function unionRectangles(left: BrainPetRectangle, right: BrainPetRectangle): BrainPetRectangle {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

function expandWithinWorkArea(rectangle: BrainPetRectangle, margin: number, workArea: BrainPetRectangle): BrainPetRectangle {
  const x = Math.max(workArea.x, rectangle.x - margin);
  const y = Math.max(workArea.y, rectangle.y - margin);
  const right = Math.min(workArea.x + workArea.width, rectangle.x + rectangle.width + margin);
  const bottom = Math.min(workArea.y + workArea.height, rectangle.y + rectangle.height + margin);
  return roundRectangle({ x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) });
}

function translateRectangle(rectangle: BrainPetRectangle, delta: BrainPetPoint): BrainPetRectangle {
  return { ...rectangle, x: rectangle.x + delta.x, y: rectangle.y + delta.y };
}

function roundRectangle(rectangle: BrainPetRectangle): BrainPetRectangle {
  return {
    x: Math.round(rectangle.x),
    y: Math.round(rectangle.y),
    width: Math.round(rectangle.width),
    height: Math.round(rectangle.height),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
