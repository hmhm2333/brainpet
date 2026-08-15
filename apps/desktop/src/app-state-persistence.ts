import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const topLevelKeys = ["version", "preferences", "pets", "defaultPet", "activity"] as const;
const preferenceKeys = ["defaultPetId", "openDefaultPetOnLaunch", "locale", "appearanceTheme", "speechBubblesEnabled", "petScale", "waitingAnimationDurationMs", "reactionAnimationOverrides", "onboardingCompleted", "claudeCommandPath", "nodeCommandPath", "opencodeCommandPath", "petPoolOrder", "petPoolEnabled", "petConfinementEnabled", "petCrossDisplayEnabled", "petGravityEnabled", "primaryCompanionFollowMode"] as const;
const petContainerKeys = ["installed"] as const;
const defaultPetKeys = ["position", "perMonitorPositions"] as const;
const activityKeys = ["messagesSent", "reactionsSent", "reactionCounts", "perPetActivityCounts", "lastActivityAt"] as const;

type StateEnvelope = Record<string, unknown> & {
  preferences: Record<string, unknown>;
  pets: Record<string, unknown>;
  defaultPet: Record<string, unknown>;
  activity: Record<string, unknown>;
};

/** Preserves forward-compatible fields while known fields always come from the normalized state. */
export function preserveAppStateUnknownFields<T extends StateEnvelope>(source: unknown, normalized: T): T {
  const record = isRecord(source) ? source : {};
  return {
    ...copyUnknownFields(record, topLevelKeys),
    ...normalized,
    preferences: {
      ...copyUnknownFields(isRecord(record.preferences) ? record.preferences : {}, preferenceKeys),
      ...normalized.preferences,
    },
    pets: {
      ...copyUnknownFields(isRecord(record.pets) ? record.pets : {}, petContainerKeys),
      ...normalized.pets,
    },
    defaultPet: {
      ...copyUnknownFields(isRecord(record.defaultPet) ? record.defaultPet : {}, defaultPetKeys),
      ...normalized.defaultPet,
    },
    activity: {
      ...copyUnknownFields(isRecord(record.activity) ? record.activity : {}, activityKeys),
      ...normalized.activity,
    },
  } as T;
}

export function writeJsonFileAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    try {
      const current = readFileSync(path, "utf8");
      JSON.parse(current) as unknown;
      replaceTextFileAtomically(`${path}.bak`, current);
    } catch {
      // Never replace a last-known-good backup with a malformed primary file.
    }
  }
  replaceTextFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonFileWithBackup(path: string): { readonly value: unknown; readonly recoveredFromBackup: boolean } | undefined {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) as unknown, recoveredFromBackup: false };
  } catch {
    try {
      return { value: JSON.parse(readFileSync(`${path}.bak`, "utf8")) as unknown, recoveredFromBackup: true };
    } catch {
      return undefined;
    }
  }
}

export function copyUnknownFields(record: Record<string, unknown>, knownKeys: readonly string[]): Record<string, unknown> {
  const known = new Set(knownKeys);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !known.has(key)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replaceTextFileAtomically(path: string, contents: string): void {
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}
