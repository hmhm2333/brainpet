import assert from "node:assert/strict";

import { parseArgs, validatePetId, validateProduct } from "./index.js";

assert.deepEqual(parseArgs(["--product", "brainpet", "review-owl"]), { petId: "review-owl", product: "brainpet", help: false });
assert.deepEqual(parseArgs(["review-owl", "--product=openpets"]), { petId: "review-owl", product: "openpets", help: false });
assert.equal(parseArgs(["--help"]).help, true);
assert.throws(() => parseArgs(["review-owl"]), /Missing required --product/);
assert.throws(() => parseArgs(["--product", "other", "review-owl"]), /Invalid product target/);
assert.equal(validateProduct("brainpet"), "brainpet");
assert.equal(validatePetId("review-owl"), "review-owl");
assert.throws(() => validatePetId("../escape"), /Invalid OpenPets pet id/);

process.stdout.write("install-pet host-only contract passed.\n");
