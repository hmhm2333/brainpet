#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleBridgeRelease } from "../integrations/codex/scripts/assemble-bridge-release.mjs";
import { validateBridgeRelease } from "../integrations/codex/scripts/validate-bridge-release.mjs";
import { aggregateBrainPetReleaseReceipt } from "./aggregate-brainpet-release-receipt.mjs";
import { brainPetDistributionContract, brainPetReleaseTargets, getBrainPetReleaseTarget } from "./brainpet-release-contract.mjs";
import { assertBrainPetBinary } from "./brainpet-binary-format.mjs";
import { brainPetPhysicalCheckIds, validateBrainPetPhysicalReceiptSet } from "./brainpet-physical-receipt-contract.mjs";
import { createBrainPetPhysicalApprovalComment, intakeBrainPetPhysicalReceipts, validateEnvironmentApproval } from "./intake-brainpet-physical-receipts.mjs";
import { brainPetPhysicalReceiptWorkflow, brainPetPublicReleaseFinalizeWorkflow, brainPetPublicReleaseWorkflow, brainPetSigstoreBundlePath, signBrainPetReleaseEvidence, signBrainPetSubjects, verifyBrainPetSigstoreSubject } from "./brainpet-sigstore-provenance.mjs";
import { stageBrainPetPackageArtifacts, validateBrainPetPackageArtifactClosure } from "./stage-brainpet-package-artifacts.mjs";
import { createBrainPetBuilderInvocation, parseBrainPetPackageArgs, prepareBrainPetBundledMarketplace, resolveBrainPetElectronDist, validatePublicReleaseEnvironment } from "../apps/desktop/scripts/brainpet-package.mjs";
import { assertMacosCodeObjectIsUnsigned, resolveBrainPetResourcesRoot, validateUnsignedLinuxArtifacts } from "../apps/desktop/scripts/validate-brainpet-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = join(root, "output", "brainpet-m5-release-test", String(process.pid));
const artifactsRoot = join(testRoot, "artifacts");
const pluginRoot = join(testRoot, "brainpet-codex-bridge");
const packagesRoot = join(testRoot, "packages");
const publicPackagesRoot = join(testRoot, "public-packages");
const lifecycleRoot = join(testRoot, "lifecycle");
const receiptsRoot = join(testRoot, "receipts");
const provenanceRoot = join(testRoot, "provenance");

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
  const bridgeHookPath = join(pluginRoot, "hooks", "hooks.json");
  const bridgeHookBytes = readFileSync(bridgeHookPath);
  writeFileSync(bridgeHookPath, Buffer.concat([bridgeHookBytes, Buffer.from("\n")]));
  assert.throws(() => validateBridgeRelease(pluginRoot), /artifact tree/i);
  writeFileSync(bridgeHookPath, bridgeHookBytes);
  const bridgeExtraPath = join(pluginRoot, "unexpected-release-payload.mjs");
  writeFileSync(bridgeExtraPath, "export default true;\n", "utf8");
  assert.throws(() => validateBridgeRelease(pluginRoot), /artifact tree/i);
  rmSync(bridgeExtraPath);
  const bridgeExtraDirectory = join(pluginRoot, "unexpected-empty-directory");
  mkdirSync(bridgeExtraDirectory);
  assert.throws(() => validateBridgeRelease(pluginRoot), /artifact tree/i);
  rmSync(bridgeExtraDirectory, { recursive: true });
  const bridgeCorePath = join(pluginRoot, "scripts", "bridge-core.mjs");
  const bridgeCoreBytes = readFileSync(bridgeCorePath);
  rmSync(bridgeCorePath);
  assert.throws(() => validateBridgeRelease(pluginRoot), /artifact tree/i);
  writeFileSync(bridgeCorePath, bridgeCoreBytes);
  assert.deepEqual(validateBridgeRelease(pluginRoot), { targetCount: 6, receipt: true });
  assert.throws(() => assertBrainPetBinary(Buffer.alloc(20 * 1024, 7), brainPetReleaseTargets[0]), /Unsupported executable/);
  for (const target of brainPetReleaseTargets) assert.deepEqual(validatePublicReleaseEnvironment(target), brainPetDistributionContract.releasePolicy);
  assert.deepEqual(brainPetReleaseTargets.map((target) => target.supportLevel), ["stable", "preview", "beta", "stable", "beta", "preview"]);
  const versionFixture = parseBrainPetPackageArgs(["--platform", "windows", "--arch", "x64", "--target", "dir", "--mode", "private-test", "--app-version", "3.3.999", "--output", "apps/desktop/dist-brainpet/contract-fixture"]);
  const invocation = createBrainPetBuilderInvocation(versionFixture);
  assert.ok(invocation.args.some((arg) => arg.endsWith("extraMetadata.version=3.3.999")));
  const publicWindowsInvocation = createBrainPetBuilderInvocation(parseBrainPetPackageArgs(["--platform", "windows", "--arch", "x64", "--target", "installer", "--mode", "public-release", "--dry-run"]));
  assert.ok(publicWindowsInvocation.args.includes("nsis"));
  assert.equal(publicWindowsInvocation.args.includes("portable"), false);
  const publicLinuxInvocation = createBrainPetBuilderInvocation(parseBrainPetPackageArgs(["--platform", "linux", "--arch", "x64", "--target", "installer", "--mode", "public-release", "--dry-run"]));
  assert.ok(publicLinuxInvocation.args.includes("AppImage"));
  assert.ok(publicLinuxInvocation.args.includes("deb"));
  const dryRunFixture = parseBrainPetPackageArgs(["--platform", "linux", "--arch", "x64", "--target", "installer", "--mode", "private-test", "--dry-run"]);
  const fakeElectronPackage = join(root, "node_modules", ".pnpm", "electron@42.0.0", "node_modules", "electron", "package.json");
  assert.equal(
    resolveBrainPetElectronDist(
      dryRunFixture,
      () => fakeElectronPackage,
      () => assert.fail("dry-run must not load or download Electron"),
    ),
    join(dirname(fakeElectronPackage), "dist"),
  );
  let electronLoaded = false;
  const resolvedMacDist = resolveBrainPetElectronDist(
    { ...dryRunFixture, dryRun: false, releaseTarget: getBrainPetReleaseTarget("macos", "arm64") },
    () => fakeElectronPackage,
    () => { electronLoaded = true; },
    () => electronLoaded,
  );
  assert.equal(resolvedMacDist, join(dirname(fakeElectronPackage), "dist"));
  assert.equal(electronLoaded, true, "missing Electron distributions must be prepared before electron-builder runs");
  assert.equal(resolveBrainPetResourcesRoot("/fixture/app", getBrainPetReleaseTarget("linux", "x64")), join("/fixture/app", "resources"));
  assert.equal(resolveBrainPetResourcesRoot("/fixture/app", getBrainPetReleaseTarget("macos", "arm64")), join("/fixture/app", "Resources"));
  assert.equal(assertMacosCodeObjectIsUnsigned({ status: 1, stdout: "", stderr: "code object is not signed at all" }, "fixture"), true);
  for (const signedIdentity of ["adhoc", "Apple Development", "3rd Party Mac Developer Application", "self-signed"]) {
    assert.throws(() => assertMacosCodeObjectIsUnsigned({ status: 0, stdout: "", stderr: `Signature=\nAuthority=${signedIdentity}` }, signedIdentity), /contains a code signature/i);
  }
  assert.equal(validateUnsignedLinuxArtifacts([{ kind: "appimage", path: "/fixture/BrainPet.AppImage" }, { kind: "deb", path: "/fixture/BrainPet.deb" }], (command) => command === "ar"
    ? { status: 0, stdout: "debian-binary\ncontrol.tar.xz\ndata.tar.xz\n", stderr: "" }
    : { status: 0, stdout: Buffer.from("\n"), stderr: Buffer.alloc(0) }), true);
  assert.throws(() => validateUnsignedLinuxArtifacts([{ kind: "appimage", path: "/fixture/signed.AppImage" }], () => ({ status: 0, stdout: Buffer.from("-----BEGIN PGP SIGNATURE-----"), stderr: Buffer.alloc(0) })), /embedded signature/i);
  assert.throws(() => validateUnsignedLinuxArtifacts([{ kind: "deb", path: "/fixture/signed.deb" }], () => ({ status: 0, stdout: "debian-binary\ncontrol.tar.xz\ndata.tar.xz\n_gpgorigin\n", stderr: "" })), /embedded signature|non-standard/i);
  assert.ok(invocation.args.some((arg) => arg.includes("directories.output=")));
  assert.throws(() => parseBrainPetPackageArgs(["--mode", "public-release", "--defer-trust"]), /was removed/);
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
    "macos-arm64:direct-runtime-package",
    "macos-arm64:physical-acceptance",
    "windows-x64:direct-runtime-package",
    "windows-x64:physical-acceptance",
  ]);
  const tamperedArtifact = aggregateFixture.artifacts.get("windows-x64/nsis");
  const originalArtifactBytes = readFileSync(tamperedArtifact);
  writeFileSync(tamperedArtifact, Buffer.alloc(originalArtifactBytes.length, 0x41));
  assert.throws(() => aggregateBrainPetReleaseReceipt({
    packagesRoot,
    lifecycleRoot,
    bridgeRoot: pluginRoot,
    outputPath: join(receiptsRoot, "tampered-release-receipt.json"),
    receiptRoot: receiptsRoot,
    releaseMode: "private-test",
  }), /hash mismatch/i);
  writeFileSync(tamperedArtifact, originalArtifactBytes);
  const intakeCandidatePath = join(testRoot, "intake-candidate.json");
  writeFileSync(intakeCandidatePath, `${JSON.stringify({
    schemaVersion: 2,
    product: "brainpet",
    releaseMode: "public-release",
    sourceCommit: receipt.source.commit,
    sourceRunId: "123",
    physicalChallenge: "a".repeat(64),
    rc6GatePassed: true,
    publicReleaseReady: false,
  }, null, 2)}\n`, "utf8");
  const intakeCandidate = { runId: "123", receiptSha256: sha256(readFileSync(intakeCandidatePath)), challenge: "a".repeat(64) };
  const physicalReceipts = [createPhysicalReceipt("windows-x64", receipt.source.commit, undefined, intakeCandidate), createPhysicalReceipt("macos-arm64", receipt.source.commit, undefined, intakeCandidate)];
  physicalReceipts[0].checks[0].note = "local-only detail";
  const physicalPayload = JSON.stringify(physicalReceipts);
  const approvalComment = createBrainPetPhysicalApprovalComment(intakeCandidate, physicalPayload);
  const approvalHistoryPath = join(testRoot, "approval-history.json");
  writeFileSync(approvalHistoryPath, `${JSON.stringify([{ state: "approved", comment: approvalComment, environments: [{ name: "brainpet-physical-acceptance" }], user: { login: "release-fixture" } }], null, 2)}\n`, "utf8");
  assert.equal(validateEnvironmentApproval(approvalHistoryPath, "release-dispatcher", approvalComment), "release-fixture");
  assert.throws(() => validateEnvironmentApproval(approvalHistoryPath, "release-fixture", approvalComment), /self-review/i);
  assert.throws(() => validateEnvironmentApproval(approvalHistoryPath, "release-dispatcher", `${approvalComment}-tampered`), /does not bind/i);
  const rerunIntake = spawnSync(process.execPath, [
    join(root, "scripts", "intake-brainpet-physical-receipts.mjs"),
    "--payload-env", "BRAINPET_TEST_PHYSICAL_PAYLOAD",
    "--candidate-receipt", intakeCandidatePath,
    "--approval-history", approvalHistoryPath,
    "--require-trusted-ci",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      BRAINPET_TEST_PHYSICAL_PAYLOAD: physicalPayload,
      GITHUB_ACTIONS: "true",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_WORKFLOW: brainPetPhysicalReceiptWorkflow.name,
      RUNNER_ENVIRONMENT: "github-hosted",
    },
  });
  assert.equal(rerunIntake.status, 1);
  assert.match(rerunIntake.stderr, /reruns are forbidden/i);
  assert.equal(validateBrainPetPhysicalReceiptSet(physicalReceipts, { expectedSourceCommit: receipt.source.commit }).length, 2);
  const unsafePhysicalReceipt = structuredClone(physicalReceipts[0]);
  unsafePhysicalReceipt.artifact.name = "C:\\Users\\person\\BrainPet-setup.exe";
  assert.throws(() => validateBrainPetPhysicalReceiptSet([unsafePhysicalReceipt, physicalReceipts[1]], { expectedSourceCommit: receipt.source.commit }), /local path/i);
  const consentMissingReceipt = structuredClone(physicalReceipts[0]);
  consentMissingReceipt.checks = consentMissingReceipt.checks.filter((check) => check.id !== "unsigned-security-prompt");
  assert.throws(() => validateBrainPetPhysicalReceiptSet([consentMissingReceipt, physicalReceipts[1]], { expectedSourceCommit: receipt.source.commit }), /check set/i);
  const replayedReceipt = structuredClone(physicalReceipts[0]);
  replayedReceipt.candidate.challenge = "b".repeat(64);
  assert.throws(() => validateBrainPetPhysicalReceiptSet([replayedReceipt, physicalReceipts[1]], { expectedSourceCommit: receipt.source.commit, expectedCandidate: intakeCandidate }), /challenge/i);
  const wrongCandidateDigestReceipt = structuredClone(physicalReceipts[0]);
  wrongCandidateDigestReceipt.candidate.receiptSha256 = "c".repeat(64);
  assert.throws(() => validateBrainPetPhysicalReceiptSet([wrongCandidateDigestReceipt, physicalReceipts[1]], { expectedSourceCommit: receipt.source.commit, expectedCandidate: intakeCandidate }), /candidate receipt bytes/i);
  const wrongReviewerReceipt = structuredClone(physicalReceipts[0]);
  wrongReviewerReceipt.reviewer = "unapproved-reviewer";
  assert.throws(() => validateBrainPetPhysicalReceiptSet([wrongReviewerReceipt, physicalReceipts[1]], { expectedSourceCommit: receipt.source.commit, expectedCandidate: intakeCandidate, expectedReviewer: "release-fixture" }), /authenticated environment reviewer/i);
  const intakeRoot = join(testRoot, "physical-intake");
  assert.equal(intakeBrainPetPhysicalReceipts({
    receiptPaths: [],
    payload: physicalPayload,
    candidateReceiptPath: intakeCandidatePath,
    expectedSourceCommit: receipt.source.commit,
    outputRoot: intakeRoot,
    approvalHistoryPath,
    authenticatedActor: "release-dispatcher",
    identity: { workflow: "BrainPet physical receipt intake", runId: "123", runAttempt: "1", actor: "release-dispatcher", environment: "brainpet-physical-acceptance", runnerEnvironment: "github-hosted" },
  }).length, 2);
  assert.ok(existsSync(join(intakeRoot, "windows-x64", "brainpet-physical-receipt.json")));
  assert.ok(existsSync(join(intakeRoot, "macos-arm64", "brainpet-physical-receipt.json")));
  assert.ok(existsSync(join(intakeRoot, "brainpet-physical-intake.json")));
  assert.equal(JSON.parse(readFileSync(join(intakeRoot, "windows-x64", "brainpet-physical-receipt.json"), "utf8")).checks[0].note, "");
  preparePublicAggregateFixture(receipt.source.commit);
  const closureProbe = join(publicPackagesRoot, "windows-x64", "unexpected-portable.exe");
  writeFileSync(closureProbe, createExecutableFixture(getBrainPetReleaseTarget("windows", "x64"), 32 * 1024));
  assert.throws(() => validateBrainPetPackageArtifactClosure(dirname(closureProbe), "windows-x64"), /unreceipted file/i);
  rmSync(closureProbe);
  const signedClaimReceiptPath = join(publicPackagesRoot, "windows-x64", "brainpet-package-receipt-windows-x64.json");
  const signedClaimReceipt = JSON.parse(readFileSync(signedClaimReceiptPath, "utf8"));
  signedClaimReceipt.signatureValidated = true;
  writeFileSync(signedClaimReceiptPath, `${JSON.stringify(signedClaimReceipt, null, 2)}\n`, "utf8");
  assert.throws(() => aggregateBrainPetReleaseReceipt({
    packagesRoot: publicPackagesRoot,
    lifecycleRoot,
    bridgeRoot: pluginRoot,
    provenanceRoot,
    outputPath: join(receiptsRoot, "signed-claim-release-receipt.json"),
    receiptRoot: receiptsRoot,
    releaseMode: "public-release",
    provenanceVerifier: () => undefined,
  }), /must not claim a platform publisher signature/i);
  signedClaimReceipt.signatureValidated = false;
  writeFileSync(signedClaimReceiptPath, `${JSON.stringify(signedClaimReceipt, null, 2)}\n`, "utf8");
  assert.throws(() => signBrainPetSubjects([aggregateFixture.artifacts.get("windows-x64/nsis")], join(testRoot, "untrusted-provenance"), {
    environment: trustedSigningEnvironment(receipt.source.commit, { RUNNER_ENVIRONMENT: "self-hosted" }),
    signer: () => assert.fail("untrusted signing must not run"),
  }), /GitHub-hosted/);
  assert.equal(signBrainPetSubjects([aggregateFixture.artifacts.get("windows-x64/nsis")], join(testRoot, "finalize-provenance"), {
    environment: trustedSigningEnvironment(receipt.source.commit, { GITHUB_WORKFLOW: brainPetPublicReleaseFinalizeWorkflow.name }),
    signer: ({ bundlePath }) => writeFileSync(bundlePath, "{}\n", { encoding: "utf8", flag: "wx" }),
    verifier: () => undefined,
  }).length, 1);
  const verifiedSubject = aggregateFixture.artifacts.get("windows-x64/nsis");
  verifyBrainPetSigstoreSubject({
    subjectPath: verifiedSubject,
    bundlesRoot: provenanceRoot,
    repository: brainPetDistributionContract.identity.repository,
    workflowPath: brainPetPublicReleaseWorkflow.path,
    workflowName: brainPetPublicReleaseWorkflow.name,
    sourceCommit: receipt.source.commit,
    label: "Sigstore CLI contract fixture",
    commandRunner(command, args) {
      assert.equal(command, "cosign");
      assert.equal(args[0], "verify-blob");
      assert.ok(args.includes("--certificate-github-workflow-repository"));
      assert.ok(args.includes(brainPetDistributionContract.identity.repository));
      assert.ok(args.includes("--certificate-github-workflow-sha"));
      assert.ok(args.includes(receipt.source.commit));
      assert.ok(args.some((arg) => typeof arg === "string" && arg.includes("brainpet-public-release-gate\\.yml@refs/")));
      return { status: 0, stdout: "Verified OK", stderr: "" };
    },
  });
  const verifiedProvenance = [];
  const provenanceVerifier = (evidence) => {
    assert.ok(existsSync(evidence.subjectPath));
    assert.ok(existsSync(evidence.bundlePath));
    assert.equal(evidence.repository, brainPetDistributionContract.identity.repository);
    const expectedWorkflow = evidence.label.startsWith("physical") ? brainPetPhysicalReceiptWorkflow : brainPetPublicReleaseWorkflow;
    assert.equal(evidence.workflowPath, expectedWorkflow.path);
    assert.equal(evidence.workflowName, expectedWorkflow.name);
    assert.equal(evidence.sourceCommit, receipt.source.commit);
    verifiedProvenance.push(evidence.label);
  };
  const mixedRunReceiptPath = join(publicPackagesRoot, "windows-x64", "brainpet-package-receipt-windows-x64.json");
  const mixedRunReceipt = JSON.parse(readFileSync(mixedRunReceiptPath, "utf8"));
  mixedRunReceipt.source.runId = "999";
  writeFileSync(mixedRunReceiptPath, `${JSON.stringify(mixedRunReceipt, null, 2)}\n`, "utf8");
  assert.throws(() => aggregateBrainPetReleaseReceipt({
    packagesRoot: publicPackagesRoot,
    lifecycleRoot,
    bridgeRoot: pluginRoot,
    provenanceRoot,
    outputPath: join(receiptsRoot, "mixed-run-release-receipt.json"),
    receiptRoot: receiptsRoot,
    releaseMode: "public-release",
    provenanceVerifier: () => undefined,
  }), /one exact workflow run/);
  mixedRunReceipt.source.runId = "123";
  writeFileSync(mixedRunReceiptPath, `${JSON.stringify(mixedRunReceipt, null, 2)}\n`, "utf8");
  verifiedProvenance.length = 0;
  const publicCandidate = aggregateBrainPetReleaseReceipt({
    packagesRoot: publicPackagesRoot,
    lifecycleRoot,
    bridgeRoot: pluginRoot,
    provenanceRoot,
    outputPath: join(receiptsRoot, "brainpet-public-candidate-receipt.json"),
    receiptRoot: receiptsRoot,
    releaseMode: "public-release",
    provenanceVerifier,
  });
  assert.equal(publicCandidate.rc6GatePassed, true);
  assert.equal(publicCandidate.sourceRunId, "123");
  assert.equal(publicCandidate.sourceRunAttempt, "1");
  assert.equal(publicCandidate.packages.find((entry) => entry.target === "linux-x64").runtimeReleaseReady, true);
  assert.equal(publicCandidate.packages.find((entry) => entry.target === "linux-x64").provenanceValidated, true);
  assert.equal(publicCandidate.publicReleaseReady, false);
  assert.match(publicCandidate.physicalChallenge, /^[a-f0-9]{64}$/);
  assert.deepEqual(publicCandidate.missingEvidence.sort(), ["macos-arm64:physical-acceptance", "windows-x64:physical-acceptance"]);
  assert.equal(verifiedProvenance.length, 19);
  const publicPhysicalRoot = join(testRoot, "public-physical");
  const publicCandidatePath = join(receiptsRoot, "brainpet-public-candidate-receipt.json");
  const physicalCandidate = { runId: "123", receiptSha256: sha256(readFileSync(publicCandidatePath)), challenge: publicCandidate.physicalChallenge };
  const publicPhysicalReceipts = [];
  for (const [targetId, artifactKind] of [["windows-x64", "nsis"], ["macos-arm64", "dmg"]]) {
    const rawArtifactSha256 = sha256(readFileSync(aggregateFixture.artifacts.get(`${targetId}/${artifactKind}`)));
    const artifactSha256 = targetId === "windows-x64" ? rawArtifactSha256.toUpperCase() : rawArtifactSha256;
    publicPhysicalReceipts.push(createPhysicalReceipt(targetId, receipt.source.commit, artifactSha256, physicalCandidate));
  }
  const publicPhysicalPayload = JSON.stringify(publicPhysicalReceipts);
  const publicApprovalHistoryPath = join(testRoot, "public-approval-history.json");
  const publicApprovalComment = createBrainPetPhysicalApprovalComment(physicalCandidate, publicPhysicalPayload);
  writeFileSync(publicApprovalHistoryPath, `${JSON.stringify([{ state: "approved", comment: publicApprovalComment, environments: [{ name: "brainpet-physical-acceptance" }], user: { login: "release-fixture" } }], null, 2)}\n`, "utf8");
  intakeBrainPetPhysicalReceipts({
    receiptPaths: [],
    payload: publicPhysicalPayload,
    candidateReceiptPath: publicCandidatePath,
    expectedSourceCommit: receipt.source.commit,
    outputRoot: publicPhysicalRoot,
    approvalHistoryPath: publicApprovalHistoryPath,
    authenticatedActor: "release-dispatcher",
    identity: { workflow: brainPetPhysicalReceiptWorkflow.name, runId: "456", runAttempt: "1", actor: "release-dispatcher", environment: "brainpet-physical-acceptance", runnerEnvironment: "github-hosted" },
  });
  assert.throws(() => aggregateBrainPetReleaseReceipt({
    packagesRoot: publicPackagesRoot,
    lifecycleRoot,
    bridgeRoot: pluginRoot,
    physicalRoot: publicPhysicalRoot,
    provenanceRoot,
    outputPath: join(receiptsRoot, "forged-json-only-release-receipt.json"),
    receiptRoot: receiptsRoot,
    releaseMode: "public-release",
    provenanceVerifier,
  }), /physical-provenance/i);
  const physicalProvenanceRoot = join(testRoot, "physical-provenance");
  mkdirSync(physicalProvenanceRoot, { recursive: true });
  for (const subjectPath of [join(publicPhysicalRoot, "windows-x64", "brainpet-physical-receipt.json"), join(publicPhysicalRoot, "macos-arm64", "brainpet-physical-receipt.json"), join(publicPhysicalRoot, "brainpet-physical-intake.json")]) {
    writeFileSync(brainPetSigstoreBundlePath(physicalProvenanceRoot, sha256(readFileSync(subjectPath))), "{}\n", "utf8");
  }
  const publicPhysicalIntakePath = join(publicPhysicalRoot, "brainpet-physical-intake.json");
  const publicPhysicalIntakeBytes = readFileSync(publicPhysicalIntakePath);
  const rerunPhysicalIntake = JSON.parse(publicPhysicalIntakeBytes);
  rerunPhysicalIntake.github.runAttempt = "2";
  writeFileSync(publicPhysicalIntakePath, `${JSON.stringify(rerunPhysicalIntake, null, 2)}\n`, "utf8");
  assert.throws(() => aggregateBrainPetReleaseReceipt({
    packagesRoot: publicPackagesRoot,
    lifecycleRoot,
    bridgeRoot: pluginRoot,
    physicalRoot: publicPhysicalRoot,
    physicalProvenanceRoot,
    provenanceRoot,
    outputPath: join(receiptsRoot, "rerun-physical-release-receipt.json"),
    receiptRoot: receiptsRoot,
    releaseMode: "public-release",
    provenanceVerifier,
  }), /reruns are not releasable/i);
  writeFileSync(publicPhysicalIntakePath, publicPhysicalIntakeBytes);
  verifiedProvenance.length = 0;
  const publicFinal = aggregateBrainPetReleaseReceipt({
    packagesRoot: publicPackagesRoot,
    lifecycleRoot,
    bridgeRoot: pluginRoot,
    physicalRoot: publicPhysicalRoot,
    physicalProvenanceRoot,
    provenanceRoot,
    outputPath: join(receiptsRoot, "brainpet-public-release-receipt.json"),
    receiptRoot: receiptsRoot,
    releaseMode: "public-release",
    expectPublicReady: true,
    provenanceVerifier,
  });
  assert.equal(publicFinal.publicReleaseReady, true);
  assert.deepEqual(publicFinal.missingEvidence, []);
  assert.equal(verifiedProvenance.length, 22);
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
      schemaVersion: 2,
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
      installerValidated: true,
      signatureValidated: false,
      unsignedPolicyValidated: false,
      platformSignatureStatus: "not-evaluated",
      distributionChannel: "private-test",
      userConsentRequired: false,
      publisherRegistrationRequired: false,
      provenanceValidated: false,
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

function createPhysicalReceipt(targetId, sourceCommit, artifactHash, candidate = { runId: "123", receiptSha256: "b".repeat(64), challenge: "a".repeat(64) }, reviewer = "release-fixture") {
  const isWindows = targetId === "windows-x64";
  const artifactSha256 = artifactHash ?? createHash("sha256").update(`${targetId}-unsigned-installer`).digest("hex");
  return {
    schemaVersion: 5,
    scriptVersion: "brainpet-release-v5.0",
    product: "brainpet",
    target: targetId,
    sourceCommit,
    runId: `${targetId}-fixture`,
    startedAt: "2026-08-16T00:00:00.000Z",
    completedAt: "2026-08-16T00:30:00.000Z",
    mode: "interactive",
    reviewer,
    candidate,
    overallStatus: "passed",
    distributionChannel: "direct-download",
    platformSignatureStatus: "absent-by-policy",
    systemWarningObserved: true,
    userConsentConfirmed: true,
    environment: {
      platform: isWindows ? "win32" : "darwin",
      arch: isWindows ? "x64" : "arm64",
      displayCount: 2,
      displays: [{ index: 1, name: "primary" }, { index: 2, name: "secondary" }],
    },
    artifact: {
      kind: isWindows ? "nsis" : "dmg",
      name: isWindows ? "BrainPet-Unsigned-3.4.0-win-x64-setup.exe" : "BrainPet-Unsigned-3.4.0-mac-arm64.dmg",
      sizeBytes: 32 * 1024,
      sha256: artifactSha256,
      ...(isWindows ? { authenticodeStatus: "NotSigned" } : { developerIdStatus: "Absent", gatekeeperStatus: "Rejected", staplerStatus: "Invalid" }),
    },
    artifactSha256,
    checks: brainPetPhysicalCheckIds.map((id) => ({ id, status: "pass", note: "" })),
  };
}

function preparePublicAggregateFixture(sourceCommit) {
  for (const target of brainPetReleaseTargets) {
    const packageRoot = join(packagesRoot, target.id);
    const receiptPath = join(packageRoot, `brainpet-package-receipt-${target.id}.json`);
    const packageReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    packageReceipt.releaseMode = "public-release";
    packageReceipt.signatureValidated = false;
    packageReceipt.unsignedPolicyValidated = true;
    packageReceipt.platformSignatureStatus = "absent-by-policy";
    packageReceipt.distributionChannel = "direct-download";
    packageReceipt.userConsentRequired = true;
    packageReceipt.publisherRegistrationRequired = false;
    packageReceipt.provenanceValidated = false;
    packageReceipt.runtimeReleaseReady = true;
    packageReceipt.source = {
      repository: brainPetDistributionContract.identity.repository,
      commit: sourceCommit,
      githubActions: true,
      workflow: "BrainPet public release gate",
      runId: "123",
      runAttempt: "1",
      runnerEnvironment: "github-hosted",
      treeDirty: false,
    };
    writeFileSync(receiptPath, `${JSON.stringify(packageReceipt, null, 2)}\n`, "utf8");
    stageBrainPetPackageArtifacts({ sourceRoot: packageRoot, targetId: target.id, outputRoot: join(publicPackagesRoot, target.id) });
  }
  for (const [targetId, artifactKind] of [["windows-x64", "nsis"], ["macos-arm64", "dmg"], ["linux-x64", "appimage"], ["linux-x64", "deb"]]) {
    const lifecyclePath = join(lifecycleRoot, `brainpet-install-lifecycle-receipt-${targetId}-${artifactKind}.json`);
    const lifecycle = JSON.parse(readFileSync(lifecyclePath, "utf8"));
    lifecycle.source.workflow = "BrainPet public release gate";
    lifecycle.source.runId = "123";
    lifecycle.source.runAttempt = "1";
    writeFileSync(lifecyclePath, `${JSON.stringify(lifecycle, null, 2)}\n`, "utf8");
    const bundleRoot = join(lifecycleRoot, `${targetId}-${artifactKind}`);
    mkdirSync(bundleRoot, { recursive: true });
    const movedLifecycle = join(bundleRoot, basename(lifecyclePath));
    writeFileSync(movedLifecycle, readFileSync(lifecyclePath));
    rmSync(lifecyclePath);
  }
  const bridgeReceiptPath = join(pluginRoot, "brainpet-release.json");
  const bridgeReceipt = JSON.parse(readFileSync(bridgeReceiptPath, "utf8"));
  bridgeReceipt.source = {
    repository: brainPetDistributionContract.identity.repository,
    commit: sourceCommit,
    githubActions: true,
    workflow: "BrainPet public release gate",
    runId: "123",
    runAttempt: "1",
    runnerEnvironment: "github-hosted",
  };
  writeFileSync(bridgeReceiptPath, `${JSON.stringify(bridgeReceipt, null, 2)}\n`, "utf8");
  const signed = signBrainPetReleaseEvidence({
    packagesRoot: publicPackagesRoot,
    lifecycleRoot,
    bridgeRoot: pluginRoot,
    bundlesRoot: provenanceRoot,
    environment: trustedSigningEnvironment(sourceCommit),
    signer: ({ bundlePath }) => writeFileSync(bundlePath, "{}\n", { encoding: "utf8", flag: "wx" }),
    verifier: () => undefined,
  });
  assert.equal(signed.length, 19);
}

function trustedSigningEnvironment(sourceCommit, override = {}) {
  return {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_REPOSITORY: brainPetDistributionContract.identity.repository,
    GITHUB_WORKFLOW: brainPetPublicReleaseWorkflow.name,
    GITHUB_SHA: sourceCommit,
    ...override,
  };
}
