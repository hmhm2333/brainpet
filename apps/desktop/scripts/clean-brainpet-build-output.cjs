const assert = require("node:assert/strict");
const { rmSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const appDir = resolve(__dirname, "..");
for (const name of ["dist", ".brainpet-package"]) {
  const target = resolve(appDir, name);
  assert.equal(dirname(target), appDir, `Refusing to clean unexpected BrainPet build path: ${target}`);
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
