import assert from "node:assert/strict";

import { brainPetDistributionContract, brainPetReleaseTargets } from "./brainpet-release-contract.mjs";

export const brainPetPhysicalCheckIds = Object.freeze([
  "unsigned-security-prompt",
  "clean-install",
  "default-install-path",
  "no-development-toolchain",
  "default-discovery",
  "adapter-first-lifecycle",
  "upgrade-state-preserved",
  "uninstall-agent-fail-open",
  "native-pet-recovery",
  "primary-display-edges",
  "secondary-display-edges",
  "mixed-dpi",
  "sleep-wake",
  "agent-completion",
  "novice-rule-comprehension",
  "dynamic-visual",
]);

const stableTargets = brainPetReleaseTargets.filter((target) => target.supportLevel === "stable");

export function validateBrainPetPhysicalReceipt(receipt, options = {}) {
  assert.ok(isRecord(receipt), "Physical receipt must be a JSON object.");
  assert.equal(receipt.schemaVersion, 4, "Physical receipt must use schema v4.");
  assert.equal(receipt.product, "brainpet");
  assert.equal(receipt.mode, "interactive", "Only an interactive physical acceptance receipt is releasable.");
  assert.equal(receipt.overallStatus, "passed", "Physical acceptance did not pass.");
  assert.equal(receipt.distributionChannel, "direct-download", "Physical receipt must cover the direct-download channel.");
  assert.equal(receipt.platformSignatureStatus, "absent-by-policy", "Physical receipt must acknowledge the unsigned release policy.");
  assert.equal(receipt.systemWarningObserved, true, "Physical acceptance must observe the operating-system security warning.");
  assert.equal(receipt.userConsentConfirmed, true, "Physical acceptance must record explicit user consent through the operating-system UI.");
  const target = stableTargets.find((candidate) => candidate.id === receipt.target);
  assert.ok(target, `Physical receipt target is not Stable: ${receipt.target}`);
  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/i, "Physical receipt must bind an exact source commit.");
  if (options.expectedSourceCommit) assert.equal(receipt.sourceCommit.toLowerCase(), options.expectedSourceCommit.toLowerCase(), "Physical receipt source commit does not match the intake commit.");
  assert.ok(typeof receipt.reviewer === "string" && receipt.reviewer.trim().length > 0 && receipt.reviewer.length <= 128 && !/[\r\n]/.test(receipt.reviewer), "Physical receipt must identify a bounded reviewer.");
  assert.ok(typeof receipt.runId === "string" && receipt.runId.length > 0 && receipt.runId.length <= 128 && !/[\r\n]/.test(receipt.runId), "Physical receipt run id is invalid.");
  assert.ok(typeof receipt.startedAt === "string" && Number.isFinite(Date.parse(receipt.startedAt)), "Physical receipt start time is invalid.");
  assert.ok(typeof receipt.completedAt === "string" && Number.isFinite(Date.parse(receipt.completedAt)), "Physical receipt completion time is invalid.");

  assert.ok(isRecord(receipt.environment));
  assert.equal(receipt.environment.platform, target.nodePlatform, "Physical receipt ran on the wrong operating system.");
  assert.equal(receipt.environment.arch, target.arch, "Physical receipt ran on the wrong architecture.");
  assert.ok(Number.isInteger(receipt.environment.displayCount) && receipt.environment.displayCount >= 2, "Physical acceptance requires at least two displays.");
  assert.ok(Array.isArray(receipt.environment.displays) && receipt.environment.displays.length >= 2 && receipt.environment.displays.length <= 16, "Physical display inventory is incomplete.");
  assert.equal(receipt.environment.displayCount, receipt.environment.displays.length, "Physical display count does not match its inventory.");

  assert.ok(isRecord(receipt.artifact));
  assert.equal(receipt.artifact.kind, target.platform === "windows" ? "nsis" : "dmg");
  assert.ok(typeof receipt.artifact.name === "string" && receipt.artifact.name.length > 0 && receipt.artifact.name.length <= 255 && !/[\\/]/.test(receipt.artifact.name), "Physical artifact name must not contain a local path.");
  assert.match(receipt.artifact.name, /Unsigned/i, "Physical release artifact must be visibly labeled Unsigned.");
  assert.ok(Number.isSafeInteger(receipt.artifact.sizeBytes) && receipt.artifact.sizeBytes >= 16 * 1024, "Physical artifact is implausibly small.");
  assert.match(receipt.artifact.sha256, /^[a-f0-9]{64}$/i);
  assert.equal(receipt.artifactSha256, receipt.artifact.sha256, "Physical artifact hash fields disagree.");
  if (target.platform === "windows") assert.equal(receipt.artifact.authenticodeStatus, "NotSigned", "Windows direct-release artifact must remain Authenticode-unsigned.");
  else {
    assert.equal(receipt.artifact.developerIdStatus, "Absent", "macOS direct-release artifact must not contain a Developer ID signature.");
    assert.equal(receipt.artifact.gatekeeperStatus, "Rejected", "macOS direct-release artifact must not claim Gatekeeper publisher trust.");
    assert.equal(receipt.artifact.staplerStatus, "Invalid", "macOS direct-release artifact must not contain a notarization ticket.");
  }

  assert.ok(Array.isArray(receipt.checks));
  const checkIds = receipt.checks.map((check) => {
    assert.ok(isRecord(check) && typeof check.id === "string");
    assert.equal(check.status, "pass", `Physical check did not pass: ${check.id}`);
    assert.ok(typeof check.note === "string" && check.note.length <= 500 && !/[\r\n]/.test(check.note), `Physical check note is unsafe or too long: ${check.id}`);
    return check.id;
  });
  assert.equal(new Set(checkIds).size, checkIds.length, "Physical receipt contains duplicate checks.");
  assert.deepEqual([...checkIds].sort(), [...brainPetPhysicalCheckIds].sort(), "Physical receipt check set is incomplete or unknown.");
  return {
    schemaVersion: 4,
    scriptVersion: bounded(receipt.scriptVersion, 64, "Physical receipt script version"),
    product: "brainpet",
    target: receipt.target,
    sourceCommit: receipt.sourceCommit.toLowerCase(),
    runId: receipt.runId,
    startedAt: new Date(receipt.startedAt).toISOString(),
    completedAt: new Date(receipt.completedAt).toISOString(),
    mode: "interactive",
    reviewer: receipt.reviewer.trim(),
    overallStatus: "passed",
    distributionChannel: "direct-download",
    platformSignatureStatus: "absent-by-policy",
    systemWarningObserved: true,
    userConsentConfirmed: true,
    environment: {
      platform: receipt.environment.platform,
      arch: receipt.environment.arch,
      displayCount: receipt.environment.displayCount,
      displays: receipt.environment.displays.map((display, index) => normalizeDisplay(display, index)),
    },
    artifact: {
      kind: receipt.artifact.kind,
      name: receipt.artifact.name,
      sizeBytes: receipt.artifact.sizeBytes,
      sha256: receipt.artifact.sha256.toLowerCase(),
      ...(target.platform === "windows"
        ? { authenticodeStatus: "NotSigned" }
        : { developerIdStatus: "Absent", gatekeeperStatus: "Rejected", staplerStatus: "Invalid" }),
    },
    artifactSha256: receipt.artifactSha256.toLowerCase(),
    checks: receipt.checks.map((check) => ({ id: check.id, status: "pass", note: "" })),
  };
}

export function validateBrainPetPhysicalReceiptSet(receipts, options = {}) {
  assert.ok(Array.isArray(receipts), "Physical receipt payload must be an array.");
  const validated = receipts.map((receipt) => validateBrainPetPhysicalReceipt(receipt, options));
  assert.deepEqual(validated.map((receipt) => receipt.target).sort(), stableTargets.map((target) => target.id).sort(), "Physical receipt payload must contain exactly one receipt for every Stable target.");
  const commits = new Set(validated.map((receipt) => receipt.sourceCommit.toLowerCase()));
  assert.equal(commits.size, 1, "Physical receipts must bind one exact source commit.");
  return validated;
}

export function createBrainPetPhysicalIntake(receipts, identity) {
  return {
    schemaVersion: 1,
    product: "brainpet",
    repository: brainPetDistributionContract.identity.repository,
    sourceCommit: receipts[0].sourceCommit,
    targets: receipts.map((receipt) => ({ target: receipt.target, artifactSha256: receipt.artifactSha256, completedAt: receipt.completedAt })),
    github: identity,
    acceptedAt: new Date().toISOString(),
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDisplay(display, index) {
  assert.ok(isRecord(display), "Physical display entry must be an object.");
  const bounds = isRecord(display.bounds) ? display.bounds : null;
  const name = bounded(display.name ?? display.deviceName ?? `Display ${index + 1}`, 128, "Physical display name");
  const resolution = bounded(display.resolution ?? (bounds ? `${bounds.width}x${bounds.height}` : "unknown"), 128, "Physical display resolution");
  return {
    index: Number.isInteger(display.index) ? display.index : index + 1,
    name,
    resolution,
    scalePercent: Number.isFinite(display.scalePercent) ? Number(display.scalePercent) : null,
    primary: Boolean(display.primary ?? display.main),
  };
}

function bounded(value, maxLength, label) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\r\n]/.test(value), `${label} is invalid.`);
  return value;
}
