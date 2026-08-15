#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleBridgeRelease } from "../integrations/codex/scripts/assemble-bridge-release.mjs";
import { validateBridgeRelease } from "../integrations/codex/scripts/validate-bridge-release.mjs";
import { aggregateBrainPetReleaseReceipt } from "./aggregate-brainpet-release-receipt.mjs";
import { brainPetDistributionContract, brainPetReleaseTargets } from "./brainpet-release-contract.mjs";
import { assertBrainPetBinary } from "./brainpet-binary-format.mjs";
import { createBrainPetBuilderInvocation, parseBrainPetPackageArgs, prepareBrainPetBundledMarketplace, validatePublicReleaseEnvironment } from "../apps/desktop/scripts/brainpet-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = join(root, "output", "brainpet-m5-release-test", String(process.pid));
const artifactsRoot = join(testRoot, "artifacts");
const pluginRoot = join(testRoot, "brainpet-codex-bridge");
const packagesRoot = join(testRoot, "packages");
const lifecycleRoot = join(testRoot, "lifecycle");
const receiptsRoot = join(testRoot, "receipts");

try {
  for (const [index, target] of brainPetReleaseTargets.entries()) {
    const targetRoot = join(artifactsRoot, target.id);
    mkdirSync(targetRoot, { recursive: true });
    const file = join(targetRoot, target.helperName);
    writeFileSync(file, createExecutableFixture(target, 20 * 1024 + index));
    if (target.platform !== "windows") chmodSync(file, 0o755);
  }
  const receipt = assembleBridgeRelease({ artifactsRoot, outputRoot: pluginRoot });
  assert.equal(receipt.files.length, 6);
  assert.equal(new Set(receipt.files.map((file) => file.sha256)).size, 6);
  assert.deepEqual(validateBridgeRelease(pluginRoot), { targetCount: 6, receipt: true });
  assert.throws(() => assertBrainPetBinary(Buffer.alloc(20 * 1024, 7), brainPetReleaseTargets[0]), /Unsupported executable/);
  assert.throws(() => validatePublicReleaseEnvironment(brainPetReleaseTargets.find((target) => target.id === "windows-x64"), {}), /signing credentials/);
  assert.throws(() => validatePublicReleaseEnvironment(brainPetReleaseTargets.find((target) => target.id === "macos-arm64"), {}), /Developer ID/);
  assert.throws(() => validatePublicReleaseEnvironment(brainPetReleaseTargets.find((target) => target.id === "linux-x64"), {}), /provenance/i);
  assert.deepEqual(brainPetReleaseTargets.map((target) => target.supportLevel), ["stable", "preview", "beta", "stable", "beta", "preview"]);
  const versionFixture = parseBrainPetPackageArgs(["--platform", "windows", "--arch", "x64", "--target", "dir", "--mode", "private-test", "--app-version", "3.3.999", "--output", "apps/desktop/dist-brainpet/contract-fixture"]);
  const invocation = createBrainPetBuilderInvocation(versionFixture);
  assert.ok(invocation.args.some((arg) => arg.endsWith("extraMetadata.version=3.3.999")));
  assert.ok(invocation.args.some((arg) => arg.includes("directories.output=")));
  assert.throws(() => parseBrainPetPackageArgs(["--mode", "public-release", "--defer-trust"]), /GitHub Actions/);
  const windowsTarget = brainPetReleaseTargets.find((target) => target.id === "windows-x64");
  const staged = prepareBrainPetBundledMarketplace({ releaseTarget: windowsTarget, helperPath: join(artifactsRoot, windowsTarget.id, windowsTarget.helperName) });
  const stagedPlugin = join(staged.stagingMarketplaceRoot, "plugins", "brainpet-codex-bridge");
  assert.ok(existsSync(join(staged.stagingMarketplaceRoot, ".agents", "plugins", "marketplace.json")));
  assert.ok(existsSync(join(stagedPlugin, "bin", windowsTarget.id, windowsTarget.helperName)));
  assert.equal(existsSync(join(stagedPlugin, "scripts", "bridge.mjs")), false);
  assert.equal(staged.receipt.nodeFallbackBundled, false);
  assert.doesNotMatch(readFileSync(join(stagedPlugin, "scripts", "bridge.cmd"), "utf8"), /\bnode\b\s+.*bridge\.mjs/i);
  const aggregateFixture = createAggregateFixture(receipt.source.commit);
  const aggregateReceipt = aggregateBrainPetReleaseReceipt({
    packagesRoot,
    lifecycleRoot,
    bridgeRoot: pluginRoot,
    outputPath: join(receiptsRoot, "brainpet-release-receipt.json"),
    receiptRoot: receiptsRoot,
    releaseMode: "private-test",
  });
  assert.equal(aggregateReceipt.rc6GatePassed, true);
  assert.equal(aggregateReceipt.publicReleaseReady, false);
  assert.deepEqual(aggregateReceipt.missingEvidence.sort(), [
    "macos-arm64:physical-acceptance",
    "macos-arm64:trusted-runtime-package",
    "windows-x64:physical-acceptance",
    "windows-x64:trusted-runtime-package",
  ]);
  const tamperedArtifact = aggregateFixture.artifacts.get("windows-x64/nsis");
  writeFileSync(tamperedArtifact, Buffer.alloc(readFileSync(tamperedArtifact).length, 0x41));
  assert.throws(() => aggregateBrainPetReleaseReceipt({
    packagesRoot,
    lifecycleRoot,
    bridgeRoot: pluginRoot,
    outputPath: join(receiptsRoot, "tampered-release-receipt.json"),
    receiptRoot: receiptsRoot,
    releaseMode: "private-test",
  }), /hash mismatch/i);
  console.log("BrainPet release assembly test passed.");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
  rmSync(join(root, "apps", "desktop", ".brainpet-package"), { recursive: true, force: true });
}

function createExecutableFixture(target, size) {
  const bytes = Buffer.alloc(size);
  if (target.binaryFormat === "pe") {
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(0x80, 0x3c);
    bytes.write("PE\0\0", 0x80, "binary");
    bytes.writeUInt16LE(target.machine, 0x84);
    bytes.writeUInt16LE(1, 0x86);
    bytes.writeUInt16LE(0xf0, 0x94);
    bytes.writeUInt16LE(0x20b, 0x98);
  } else if (target.binaryFormat === "elf") {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    bytes.writeUInt16LE(3, 16);
    bytes.writeUInt16LE(target.machine, 18);
    bytes.writeUInt32LE(1, 20);
    bytes.writeBigUInt64LE(64n, 32);
    bytes.writeUInt16LE(64, 52);
    bytes.writeUInt16LE(56, 54);
    bytes.writeUInt16LE(1, 56);
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target.machine, 4);
    bytes.writeUInt32LE(2, 12);
    bytes.writeUInt32LE(1, 16);
    bytes.writeUInt32LE(72, 20);
    bytes.writeUInt32LE(0x19, 32);
    bytes.writeUInt32LE(72, 36);
  }
  return bytes;
}

function createAggregateFixture(sourceCommit) {
  const artifacts = new Map();
  const artifactKinds = {
    windows: ["nsis"],
    macos: ["dmg"],
    linux: ["appimage", "deb"],
  };
  for (const [targetIndex, target] of brainPetReleaseTargets.entries()) {
    const packageRoot = join(packagesRoot, target.id);
    mkdirSync(packageRoot, { recursive: true });
    const executable = join(packageRoot, target.platform === "windows" ? "brainpet.exe" : "brainpet");
    writeFileSync(executable, createExecutableFixture(target, 24 * 1024 + targetIndex));
    const artifactRecords = artifactKinds[target.platform].map((kind, kindIndex) => {
      const path = join(packageRoot, `brainpet-${target.id}.${artifactExtension(kind)}`);
      const bytes = createInstallerFixture(target, kind, 28 * 1024 + targetIndex + kindIndex);
      writeFileSync(path, bytes);
      artifacts.set(`${target.id}/${kind}`, path);
      return { kind, path: path.slice(packageRoot.length + 1).replaceAll("\\", "/"), bytes: bytes.length, sha256: sha256(bytes) };
    });
    writeFileSync(join(packageRoot, `brainpet-package-receipt-${target.id}.json`), `${JSON.stringify({
      schemaVersion: 1,
      product: "brainpet",
      appId: brainPetDistributionContract.identity.appId,
      appVersion: "0.3.0",
      target: target.id,
      supportLevel: target.supportLevel,
      releaseMode: "private-test",
      packageTarget: "installer",
      source: { repository: brainPetDistributionContract.identity.repository, commit: sourceCommit },
      executable: executable.slice(packageRoot.length + 1).replaceAll("\\", "/"),
      sha256: sha256(readFileSync(executable)),
      bridgeMarketplaceBundled: true,
      nativeBridgeHelpersBundled: true,
      artifacts: artifactRecords,
      runtimeReleaseReady: false,
      publicReleaseReady: false,
    }, null, 2)}\n`, "utf8");
  }
  const lifecycleRequirements = [
    ["windows-x64", "nsis"],
    ["macos-arm64", "dmg"],
    ["linux-x64", "appimage"],
    ["linux-x64", "deb"],
  ];
  mkdirSync(lifecycleRoot, { recursive: true });
  for (const [targetId, artifactKind] of lifecycleRequirements) {
    const target = brainPetReleaseTargets.find((candidate) => candidate.id === targetId);
    const artifactPath = artifacts.get(`${targetId}/${artifactKind}`);
    writeFileSync(join(lifecycleRoot, `brainpet-install-lifecycle-receipt-${targetId}-${artifactKind}.json`), `${JSON.stringify({
      schemaVersion: 1,
      product: "brainpet",
      target: targetId,
      supportLevel: target.supportLevel,
      artifactKind,
      currentArtifact: { version: "0.3.0", sha256: sha256(readFileSync(artifactPath)) },
      source: { repository: brainPetDistributionContract.identity.repository, commit: sourceCommit, workflow: "BrainPet portability gate" },
      trustedCi: true,
      cleanRunner: true,
      realInstaller: true,
      defaultInstallPath: true,
      defaultDiscovery: true,
      packagedHelper: true,
      toolchainIsolatedHelper: true,
      install: { passed: true },
      start: { passed: true },
      adapter: { install: true, upgrade: true, uninstall: true },
      coldWake: { passed: true },
      upgrade: { passed: true, statePreserved: true },
      uninstall: { passed: true, helperFailOpen: true },
      overallStatus: "passed",
    }, null, 2)}\n`, "utf8");
  }
  mkdirSync(receiptsRoot, { recursive: true });
  return { artifacts };
}

function createInstallerFixture(target, kind, size) {
  if (kind === "nsis" || kind === "portable") return createExecutableFixture(target, size);
  if (kind === "appimage") return createExecutableFixture(target, size);
  const bytes = Buffer.alloc(size);
  if (kind === "dmg") bytes.write("koly", bytes.length - 512, "ascii");
  else if (kind === "deb") bytes.write("!<arch>\n", 0, "ascii");
  else assert.fail(`Unsupported installer fixture kind: ${kind}`);
  return bytes;
}

function artifactExtension(kind) {
  return { nsis: "exe", portable: "exe", dmg: "dmg", appimage: "AppImage", deb: "deb" }[kind];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
