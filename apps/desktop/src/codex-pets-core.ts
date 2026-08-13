export const maxCodexPetJsonBytes = 128 * 1024;
export const maxCodexSpritesheetBytes = 100 * 1024 * 1024;
export const maxCodexThumbnailSourceBytes = 24 * 1024 * 1024;
export const maxCodexPets = 100;

export interface CodexPetMetadata {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly spritesheetPath: "spritesheet.webp";
}

export function validateCodexPetMetadata(value: unknown, folderName: string): CodexPetMetadata {
  if (!isSafeCodexPetId(folderName)) throw new Error("Codex pet folder name is invalid.");
  if (!isRecord(value)) throw new Error("pet.json must be an object.");
  if (value.id !== folderName || typeof value.id !== "string") throw new Error("Codex pet id must match its folder name.");
  if (!isSafeCodexPetId(value.id)) throw new Error("Codex pet id is invalid.");
  if (typeof value.displayName !== "string" || value.displayName.trim().length === 0 || value.displayName.length > 80) throw new Error("Codex pet displayName is invalid.");
  if (typeof value.description !== "string" || value.description.trim().length === 0 || value.description.length > 500) throw new Error("Codex pet description is invalid.");
  if (value.spritesheetPath !== "spritesheet.webp") throw new Error("Codex pet spritesheetPath must be spritesheet.webp.");
  return {
    id: value.id,
    displayName: value.displayName.trim(),
    description: value.description.trim(),
    spritesheetPath: "spritesheet.webp",
  };
}

function isSafeCodexPetId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) && value !== "builtin";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
