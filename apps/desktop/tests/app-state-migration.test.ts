import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { preserveAppStateUnknownFields, readJsonFileWithBackup, writeJsonFileAtomically } from "../src/app-state-persistence.js";

const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? (existsSync(join(process.cwd(), "apps", "desktop")) ? join(process.cwd(), "apps", "desktop") : process.cwd());
const fixturePath = join(desktopRoot, "tests", "fixtures", "legacy-openpets-state.v1.json");

test("legacy state migration normalizes known fields and preserves unknown fields", () => {
  const legacy = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  const migrated = preserveAppStateUnknownFields(legacy, {
    version: 1,
    preferences: { defaultPetId: "builtin", openDefaultPetOnLaunch: false },
    pets: { installed: [] },
    defaultPet: { position: { x: 10, y: 21 } },
    activity: { messagesSent: 3, reactionsSent: 4, reactionCounts: { success: 2 }, perPetActivityCounts: {} },
  });

  assert.equal(migrated.version, 1);
  assert.equal(migrated.preferences.defaultPetId, "builtin");
  assert.deepEqual(migrated.defaultPet.position, { x: 10, y: 21 });
  assert.deepEqual((migrated as Record<string, unknown>).futureTopLevel, { owner: "future-release", enabled: true });
  assert.deepEqual((migrated.preferences as Record<string, unknown>).futurePreference, { mode: "preserve-me" });
  assert.equal((migrated.pets as Record<string, unknown>).futureCatalogCursor, "page-7");
  assert.deepEqual((migrated.defaultPet as Record<string, unknown>).futureRigCalibration, [1, 2, 3]);
  assert.equal((migrated.activity as Record<string, unknown>).futureCounter, 9);
});

test("state persistence replaces through a same-directory temporary file", () => {
  const root = mkdtempSync(join(tmpdir(), "brainpet-state-migration-"));
  try {
    const target = join(root, "openpets-state.json");
    const first = preserveAppStateUnknownFields(JSON.parse(readFileSync(fixturePath, "utf8")) as unknown, {
      version: 1,
      preferences: { defaultPetId: "builtin" },
      pets: { installed: [] },
      defaultPet: {},
      activity: {},
    });
    const state = { ...first, futureTopLevel: { revision: 2 } };
    writeJsonFileAtomically(target, first);
    writeJsonFileAtomically(target, state);

    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), state);
    assert.equal(existsSync(`${target}.${process.pid}.tmp`), false);
    assert.deepEqual(JSON.parse(readFileSync(`${target}.bak`, "utf8")), first);

    writeFileSync(target, "{malformed", "utf8");
    assert.deepEqual(readJsonFileWithBackup(target), { value: first, recoveredFromBackup: true });
    writeJsonFileAtomically(target, state);
    assert.deepEqual(JSON.parse(readFileSync(`${target}.bak`, "utf8")), first, "a malformed primary must not replace the last-known-good backup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
