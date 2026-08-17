const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { basename, extname, join, relative, resolve } = require("node:path");
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
  if (stat.isFile() && ((stat.mode & 0o111) !== 0 || basename(root) === "brainpet-hook" || codeFileExtensions.has(extname(root).toLowerCase()))) candidates.push(root);
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

function assertAdhocOnly(result, label) {
  assert.equal(result.status, 0, `${label} is not ad-hoc signed.`);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.match(output, /Signature=adhoc/i, `${label} does not have the required ad-hoc signature.`);
  assert.doesNotMatch(output, /^\s*Authority=/im, `${label} unexpectedly retains a certificate-backed signing authority.`);
}

function refreshBundledHelperReceipt(appBundle) {
  const marketplaceRoot = join(appBundle, "Contents", "Resources", "integrations", "codex", "brainpet-marketplace");
  const receiptPath = join(marketplaceRoot, "brainpet-bundle.json");
  const receiptStat = lstatSync(receiptPath);
  assert.ok(receiptStat.isFile() && !receiptStat.isSymbolicLink(), `BrainPet bundle receipt is unsafe: ${receiptPath}`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.product, "brainpet", "BrainPet bundle receipt has the wrong product identity.");
  assert.match(receipt.helper?.path ?? "", /^plugins\/brainpet-codex-bridge\/bin\/[a-z0-9-]+\/brainpet-hook$/, "BrainPet macOS helper receipt path is invalid.");
  const helperPath = resolve(marketplaceRoot, ...receipt.helper.path.split("/"));
  const helperRelative = relative(marketplaceRoot, helperPath);
  assert.ok(helperRelative && !helperRelative.startsWith(".."), "BrainPet macOS helper escaped its marketplace root.");
  const helperStat = lstatSync(helperPath);
  assert.ok(helperStat.isFile() && !helperStat.isSymbolicLink(), `BrainPet packaged helper is unsafe: ${helperPath}`);
  const helperBytes = readFileSync(helperPath);
  receipt.helper.bytes = helperBytes.length;
  receipt.helper.sha256 = createHash("sha256").update(helperBytes).digest("hex");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { receiptPath, helperPath, receipt };
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

  const signableCandidates = candidates.filter((candidate) => candidate === appBundle
    || codeBundlePattern.test(candidate)
    || codeFileExtensions.has(extname(candidate).toLowerCase())
    || basename(candidate) === "brainpet-hook"
    || stripped.includes(candidate));
  const adHocSigned = [];
  for (const candidate of signableCandidates.filter((candidate) => candidate !== appBundle)) {
    const signing = runCodesign(["--force", "--sign", "-", candidate], commandRunner);
    assert.equal(signing.status, 0, signing.stderr || `Unable to apply an ad-hoc signature to ${candidate}.`);
    assertAdhocOnly(runCodesign(["--display", "--verbose=4", candidate], commandRunner), candidate);
    adHocSigned.push(candidate);
  }
  const bundle = refreshBundledHelperReceipt(appBundle);
  const appSigning = runCodesign(["--force", "--sign", "-", appBundle], commandRunner);
  assert.equal(appSigning.status, 0, appSigning.stderr || "Unable to apply an ad-hoc signature to the BrainPet app bundle.");
  assertAdhocOnly(runCodesign(["--display", "--verbose=4", appBundle], commandRunner), "BrainPet app bundle");
  const verification = runCodesign(["--verify", "--deep", "--strict", appBundle], commandRunner);
  assert.equal(verification.status, 0, verification.stderr || "BrainPet ad-hoc app signature closure is invalid.");
  assert.equal(createHash("sha256").update(readFileSync(bundle.helperPath)).digest("hex"), bundle.receipt.helper.sha256, "Ad-hoc app signing changed the helper after its bundle receipt was refreshed.");
  adHocSigned.push(appBundle);
  return { appBundle, stripped, adHocSigned, bundle };
}

async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const result = stripMacosSignatures(context.appOutDir);
  console.log(`BrainPet replaced ${result.stripped.length} inherited macOS signatures with certificate-free ad-hoc signatures before artifact creation.`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.stripMacosSignatures = stripMacosSignatures;
