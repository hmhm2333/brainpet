import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { app } from "electron";

import { migrateAppState, normalizeInstalledPetSource } from "../src/app-state.js";
import { preserveAppStateUnknownFields, readJsonFileWithBackup, writeJsonFileAtomically } from "../src/app-state-persistence.js";

const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? (existsSync(join(process.cwd(), "apps", "desktop")) ? join(process.cwd(), "apps", "desktop") : process.cwd());
const fixturePath = join(desktopRoot, "tests", "fixtures", "legacy-openpets-state.v1.json");

function checkLegacyStateMigration(): void {
  const legacy = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  const migrated = migrateAppState(legacy);

  assert.equal(migrated.version, 1);
  assert.equal(migrated.preferences.defaultPetId, "builtin");
  assert.deepEqual(migrated.defaultPet.position, { x: 10, y: 21 });
  assert.deepEqual((migrated as Record<string, unknown>).futureTopLevel, { owner: "future-release", enabled: true });
  assert.deepEqual((migrated.preferences as Record<string, unknown>).futurePreference, { mode: "preserve-me" });
  assert.equal((migrated.pets as Record<string, unknown>).futureCatalogCursor, "page-7");
  assert.deepEqual((migrated.defaultPet as Record<string, unknown>).futureRigCalibration, [1, 2, 3]);
  assert.equal((migrated.activity as Record<string, unknown>).futureCounter, 9);
  assert.equal((migrated.activity.reactionCounts as Record<string, unknown>).futureReaction, 17);
  assert.deepEqual(normalizeInstalledPetSource({ kind: "codex", path: "C:\\pets\\owl", futureReceipt: { hash: "abc" } }), { kind: "codex", path: "C:\\pets\\owl", futureReceipt: { hash: "abc" } });
  assert.deepEqual(normalizeInstalledPetSource({ kind: "catalog", catalogVersion: 2, zip: "pet.zip", preview: "pet.webp", futureReceipt: "keep" }), { kind: "catalog", catalogVersion: 2, zip: "pet.zip", preview: "pet.webp", futureReceipt: "keep" });
}

function checkStatePersistence(): void {
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

    const migrated = migrateAppState(JSON.parse(readFileSync(fixturePath, "utf8")) as unknown);
    writeJsonFileAtomically(target, migrated);
    const roundTripped = migrateAppState(readJsonFileWithBackup(target)?.value);
    assert.equal((roundTripped.activity.reactionCounts as Record<string, unknown>).futureReaction, 17, "real migration and disk round-trip must preserve nested unknown fields");

    const beforeBackupFailure = readFileSync(target, "utf8");
    rmSync(`${target}.bak`, { force: true });
    mkdirSync(`${target}.bak`);
    assert.throws(() => writeJsonFileAtomically(target, { ...migrated, futureTopLevel: { revision: 99 } }));
    assert.equal(readFileSync(target, "utf8"), beforeBackupFailure, "a backup failure must abort replacement of the primary state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  checkLegacyStateMigration();
  checkStatePersistence();
  console.log("App state migration and persistence validation passed.");
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}
