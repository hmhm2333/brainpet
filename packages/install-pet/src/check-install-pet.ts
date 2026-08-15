import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installPet, parseArgs, validatePetId, validateProduct } from "./index.js";

assert.deepEqual(parseArgs(["--product", "brainpet", "review-owl"]), { petId: "review-owl", product: "brainpet", help: false });
assert.deepEqual(parseArgs(["review-owl", "--product=openpets"]), { petId: "review-owl", product: "openpets", help: false });
assert.equal(parseArgs(["--help"]).help, true);
assert.throws(() => parseArgs(["review-owl"]), /Missing required --product/);
assert.throws(() => parseArgs(["--product", "other", "review-owl"]), /Invalid product target/);
assert.equal(validateProduct("brainpet"), "brainpet");
assert.equal(validatePetId("review-owl"), "review-owl");
assert.throws(() => validatePetId("../escape"), /Invalid OpenPets pet id/);

const root = mkdtempSync(join(tmpdir(), "install-pet-offline-sentinel-"));
const previousDiscovery = process.env.OPENPETS_DISCOVERY_FILE;
try {
  const sentinelPath = join(root, "host-state-sentinel.json");
  const sentinel = "{\"owner\":\"host\",\"revision\":7}\n";
  writeFileSync(sentinelPath, sentinel, "utf8");
  const filesBefore = readdirSync(root);
  for (const product of ["brainpet", "openpets"] as const) {
    process.env.OPENPETS_DISCOVERY_FILE = join(root, `${product}-missing-ipc.json`);
    await assert.rejects(installPet({ product, petId: "review-owl" }), /never writes application state offline/);
    assert.equal(readFileSync(sentinelPath, "utf8"), sentinel);
    assert.deepEqual(readdirSync(root), filesBefore, `offline ${product} install must not create state or catalog files`);
  }
} finally {
  if (previousDiscovery === undefined) delete process.env.OPENPETS_DISCOVERY_FILE;
  else process.env.OPENPETS_DISCOVERY_FILE = previousDiscovery;
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("install-pet host-only contract passed.\n");
