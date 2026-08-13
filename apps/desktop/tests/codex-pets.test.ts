import assert from "node:assert/strict";

import { maxCodexPets, maxCodexSpritesheetBytes, maxCodexThumbnailSourceBytes, validateCodexPetMetadata } from "../src/codex-pets-core.js";

const valid = validateCodexPetMetadata({
  id: "fixer",
  displayName: " Fixer ",
  description: " Repairs things. ",
  spritesheetPath: "spritesheet.webp",
}, "fixer");

assert.deepEqual(valid, {
  id: "fixer",
  displayName: "Fixer",
  description: "Repairs things.",
  spritesheetPath: "spritesheet.webp",
});

assert.throws(() => validateCodexPetMetadata({ id: "other", displayName: "Other", description: "Nope", spritesheetPath: "spritesheet.webp" }, "fixer"));
assert.throws(() => validateCodexPetMetadata({ id: "builtin", displayName: "Built-in", description: "Reserved", spritesheetPath: "spritesheet.webp" }, "builtin"));
assert.throws(() => validateCodexPetMetadata({ id: "bad/id", displayName: "Bad", description: "Bad", spritesheetPath: "spritesheet.webp" }, "bad/id"));
assert.throws(() => validateCodexPetMetadata({ id: "fixer", displayName: "Fixer", description: "Nope", spritesheetPath: "../spritesheet.webp" }, "fixer"));
assert.throws(() => validateCodexPetMetadata({ id: "fixer", displayName: "", description: "Nope", spritesheetPath: "spritesheet.webp" }, "fixer"));

assert.equal(maxCodexSpritesheetBytes, 100 * 1024 * 1024);
assert.equal(maxCodexThumbnailSourceBytes, 24 * 1024 * 1024);
assert.equal(maxCodexPets, 100);

console.log("Codex pet validation passed.");
