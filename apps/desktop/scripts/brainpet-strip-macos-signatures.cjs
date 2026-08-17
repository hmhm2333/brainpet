const assert = require("node:assert/strict");
const { lstatSync, readdirSync } = require("node:fs");
const { extname, join } = require("node:path");
const { spawnSync } = require("node:child_process");

const codeBundlePattern = /\.(?:app|bundle|framework|xpc)$/i;
const codeFileExtensions = new Set([".dylib", ".node", ".so"]);

function collectCodeCandidates(root, candidates, isRoot = false) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(root)) collectCodeCandidates(join(root, entry), candidates);
    if (isRoot || codeBundlePattern.test(root)) candidates.push(root);
    return;
  }
  if (stat.isFile() && ((stat.mode & 0o111) !== 0 || codeFileExtensions.has(extname(root).toLowerCase()))) candidates.push(root);
}

function runCodesign(args, commandRunner) {
  const result = commandRunner("codesign", args, { encoding: "utf8" });
  assert.equal(result.error, undefined, `Unable to run codesign ${args.join(" ")}.`);
  assert.ok(Number.isInteger(result.status), `codesign did not return an exit status for ${args.at(-1)}.`);
  return result;
}

function assertUnsigned(result, label) {
  assert.notEqual(result.status, 0, `${label} still contains a code signature after stripping.`);
  assert.match(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, /code object is not signed at all/i, `${label} did not produce the exact unsigned codesign outcome after stripping.`);
}

function stripMacosSignatures(appOutDir, commandRunner = spawnSync) {
  const stat = lstatSync(appOutDir);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `BrainPet macOS app output is unsafe: ${appOutDir}`);
  const appBundles = readdirSync(appOutDir).filter((entry) => entry.endsWith(".app"));
  assert.equal(appBundles.length, 1, `BrainPet macOS output must contain exactly one app bundle: ${appOutDir}`);
  const appBundle = join(appOutDir, appBundles[0]);
  const candidates = [];
  collectCodeCandidates(appBundle, candidates, true);
  candidates.sort((left, right) => right.length - left.length || right.localeCompare(left));

  const stripped = [];
  for (const candidate of candidates) {
    const probe = runCodesign(["--display", "--verbose=4", candidate], commandRunner);
    if (probe.status !== 0) {
      assertUnsigned(probe, candidate);
      continue;
    }
    const removal = runCodesign(["--remove-signature", candidate], commandRunner);
    assert.equal(removal.status, 0, removal.stderr || `Unable to remove the code signature from ${candidate}.`);
    stripped.push(candidate);
  }
  for (const candidate of stripped) assertUnsigned(runCodesign(["--display", "--verbose=4", candidate], commandRunner), candidate);
  assertUnsigned(runCodesign(["--display", "--verbose=4", appBundle], commandRunner), "BrainPet app bundle");
  return { appBundle, stripped };
}

async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const result = stripMacosSignatures(context.appOutDir);
  console.log(`BrainPet stripped ${result.stripped.length} inherited macOS code signatures before artifact creation.`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.stripMacosSignatures = stripMacosSignatures;
