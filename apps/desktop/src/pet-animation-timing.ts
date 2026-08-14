export interface SpriteTimelineStop {
  readonly percent: number;
  readonly frame: number;
}

export const idleSpriteTimeline: readonly SpriteTimelineStop[] = [
  { percent: 0, frame: 0 },
  { percent: 78, frame: 0 },
  { percent: 82, frame: 1 },
  { percent: 86, frame: 2 },
  { percent: 90, frame: 3 },
  { percent: 94, frame: 4 },
  { percent: 98, frame: 5 },
  { percent: 100, frame: 5 },
] as const;

export function createIdleSpriteKeyframes(name: string, frameWidth: number, timeline: readonly SpriteTimelineStop[] = idleSpriteTimeline): string {
  if (!/^[a-z][a-z0-9-]*$/i.test(name)) throw new Error("Sprite keyframe name is invalid.");
  if (!Number.isInteger(frameWidth) || frameWidth <= 0) throw new Error("Sprite frame width must be a positive integer.");
  if (timeline.length < 2 || timeline[0]?.percent !== 0 || timeline.at(-1)?.percent !== 100) throw new Error("Sprite timeline must span 0-100 percent.");

  let previousPercent = -1;
  for (const stop of timeline) {
    if (!Number.isFinite(stop.percent) || stop.percent < 0 || stop.percent > 100 || stop.percent < previousPercent) throw new Error("Sprite timeline percentages must be ordered and bounded.");
    if (!Number.isInteger(stop.frame) || stop.frame < 0) throw new Error("Sprite timeline frames must be non-negative integers.");
    previousPercent = stop.percent;
  }

  const rows = timeline.map((stop) => `${stop.percent}% { background-position: -${stop.frame * frameWidth}px var(--sprite-row-y); }`).join("\n");
  return `@keyframes ${name} {\n${rows}\n}`;
}
