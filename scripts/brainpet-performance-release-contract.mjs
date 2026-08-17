import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { brainPetDistributionContract } from "./brainpet-release-contract.mjs";
import { assertBrainPetPerformanceWallClock, normalizeBrainPetInstantProcessMetrics } from "./brainpet-performance-metrics-contract.mjs";

const MiB = 1024 * 1024;
export const brainPetPerformanceProfiles = Object.freeze(["active-30m", "idle-24h"]);

export function validateBrainPetPerformanceReceiptObject(receipt) {
  assert.ok(isRecord(receipt), "BrainPet performance receipt must be an object.");
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.kind, "brainpet-performance-gate");
  assert.equal(receipt.product, "brainpet");
  assert.ok(brainPetPerformanceProfiles.includes(receipt.gateProfile), "BrainPet performance receipt profile is invalid.");
  assert.equal(receipt.gatePassed, true);
  assert.match(receipt.evidenceDigest ?? "", /^[a-f0-9]{64}$/i);
  const { evidenceDigest, ...core } = receipt;
  assert.equal(evidenceDigest, sha256Text(JSON.stringify(core)), "BrainPet performance receipt evidence digest is invalid.");
  const startedAt = Date.parse(receipt.startedAt);
  const completedAt = Date.parse(receipt.completedAt);
  assert.ok(Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt, "BrainPet performance receipt timestamps are invalid.");
  assertBrainPetPerformanceWallClock(receipt.startedAt, receipt.completedAt, receipt.gateProfile === "idle-24h" ? 86_400_000 : 1_800_000);
  validateCandidate(receipt.candidate);
  validateRunEvidence(receipt.runEvidence, receipt.candidate.commit, receipt.gateProfile);
  validateGateResult(receipt.gateResult, receipt.gateProfile);
  return receipt;
}

export function validateBrainPetPerformanceReceiptSet(receipts, expected = {}) {
  assert.ok(Array.isArray(receipts), "BrainPet performance receipt set must be an array.");
  const validated = receipts.map(validateBrainPetPerformanceReceiptObject).sort((left, right) => left.gateProfile.localeCompare(right.gateProfile));
  assert.deepEqual(validated.map((receipt) => receipt.gateProfile), [...brainPetPerformanceProfiles].sort(), "BrainPet performance evidence requires exactly active-30m and idle-24h receipts.");
  const commits = new Set(validated.map((receipt) => receipt.candidate.commit.toLowerCase()));
  assert.equal(commits.size, 1, "BrainPet performance receipts must bind one source commit.");
  const bindings = new Set(validated.map((receipt) => JSON.stringify({ repository: receipt.candidate.repository, commit: receipt.candidate.commit.toLowerCase(), appVersion: receipt.candidate.appVersion, target: receipt.candidate.target, executableSha256: receipt.candidate.executableSha256.toLowerCase(), appAsarSha256: receipt.candidate.appAsarSha256.toLowerCase(), runtimeTreeDigest: receipt.candidate.runtimeTreeDigest.toLowerCase() })));
  assert.equal(bindings.size, 1, "BrainPet performance receipts must bind the same packaged runtime bytes.");
  if (expected.sourceCommit) assert.equal([...commits][0], expected.sourceCommit.toLowerCase(), "BrainPet performance receipt commit is invalid.");
  if (expected.packageReceipt) {
    const packageReceipt = expected.packageReceipt;
    for (const receipt of validated) {
      assert.equal(receipt.candidate.appVersion, packageReceipt.appVersion, "BrainPet performance app version differs from the public package.");
      assert.equal(receipt.candidate.executableSha256.toLowerCase(), packageReceipt.sha256.toLowerCase(), "BrainPet performance executable differs from the public package.");
      assert.equal(receipt.candidate.appAsarSha256.toLowerCase(), packageReceipt.appAsarSha256.toLowerCase(), "BrainPet performance app.asar differs from the public package.");
      assert.equal(receipt.candidate.runtimeTreeDigest.toLowerCase(), packageReceipt.runtimeTree?.digest?.toLowerCase(), "BrainPet performance runtime tree differs from the public package.");
    }
  }
  return validated;
}

function validateCandidate(candidate) {
  assert.ok(isRecord(candidate), "BrainPet performance candidate is invalid.");
  assert.equal(candidate.repository, brainPetDistributionContract.identity.repository);
  assert.match(candidate.commit ?? "", /^[a-f0-9]{40}$/i);
  assert.match(candidate.appVersion ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(candidate.target, "windows-x64");
  for (const key of ["packageReceiptSha256", "executableSha256", "appAsarSha256", "runtimeTreeDigest"]) assert.match(candidate[key] ?? "", /^[a-f0-9]{64}$/i, `BrainPet performance candidate ${key} is invalid.`);
  for (const key of ["packageReceipt", "executable", "appAsar"]) assertPortableRelative(candidate[key], `BrainPet performance candidate ${key}`);
}

function validateRunEvidence(evidence, commit, profile) {
  assert.ok(isRecord(evidence), "BrainPet performance runner evidence is missing.");
  assert.match(evidence.runId ?? "", new RegExp(`^${escapeRegex(profile)}-${commit}-\\d{13}-[a-f0-9-]{36}$`, "i"));
  for (const key of ["manifestSha256", "resultSha256", "executionLogSha256", "completionCoreDigest"]) assert.match(evidence[key] ?? "", /^[a-f0-9]{64}$/i, `BrainPet performance runner ${key} is invalid.`);
  assert.ok(Number.isInteger(evidence.executionLogBytes) && evidence.executionLogBytes > 0, "BrainPet performance execution log length is invalid.");
}

function validateGateResult(result, profile) {
  assert.ok(isRecord(result));
  assert.equal(result.ok, true);
  assert.equal(result.gateProfile, profile);
  assert.equal(result.gatePassed, true);
  assert.equal(result.resourceBudgetEnforced, true);
  assert.ok(Number.isFinite(result.petReadyMs) && result.petReadyMs > 0, "BrainPet pet-ready latency is invalid.");
  if (profile === "idle-24h") {
    assert.deepEqual(Object.keys(result).sort(), ["gatePassed", "gateProfile", "idleProcessMetrics", "idleSoak", "ok", "petReadyMs", "rendererTargetTitles", "resourceBudgetEnforced"].sort(), "Idle performance result has unexpected fields.");
    assert.deepEqual(result.rendererTargetTitles, ["BrainPet Default Pet"]);
    normalizeBrainPetInstantProcessMetrics(result.idleProcessMetrics, "idle baseline", instantBudget(5, 400, 2_750));
    validateSoak(result.idleSoak, profile, null);
    return;
  }
  assert.deepEqual(Object.keys(result).sort(), ["activeProcessMetrics", "companionVerified", "crashIsolated", "crashRecovered", "gatePassed", "gateProfile", "hotIdleProcessMetrics", "idleProcessMetrics", "ok", "petReadyMs", "petToggleCloseVerified", "recoveredIdleProcessMetrics", "resourceBudgetEnforced", "responsiveness", "soak", "taskId"].sort(), "Active performance result has unexpected fields.");
  assert.equal(result.taskId, "cargo-signal");
  for (const key of ["companionVerified", "crashIsolated", "crashRecovered", "petToggleCloseVerified"]) assert.equal(result[key], true);
  const idleProcessMetrics = normalizeBrainPetInstantProcessMetrics(result.idleProcessMetrics, "cold idle", instantBudget(5, 400, 2_750));
  normalizeBrainPetInstantProcessMetrics(result.activeProcessMetrics, "active", instantBudget(idleProcessMetrics.processCount + 2, 650, 3_500));
  const hotIdleProcessMetrics = normalizeBrainPetInstantProcessMetrics(result.hotIdleProcessMetrics, "hot idle", instantBudget(idleProcessMetrics.processCount + 1, 500, 3_500));
  const recoveredIdleProcessMetrics = normalizeBrainPetInstantProcessMetrics(result.recoveredIdleProcessMetrics, "recovered idle", instantBudget(idleProcessMetrics.processCount + 1, 500, 3_500));
  assert.ok(hotIdleProcessMetrics.totalWorkingSetBytes - idleProcessMetrics.totalWorkingSetBytes <= 100 * MiB, "BrainPet hot idle exceeds the total-working-set delta budget.");
  assert.ok(recoveredIdleProcessMetrics.totalWorkingSetBytes - idleProcessMetrics.totalWorkingSetBytes <= 100 * MiB, "BrainPet recovered idle exceeds the total-working-set delta budget.");
  validateResponsiveness(result.responsiveness);
  validateSoak(result.soak, profile, idleProcessMetrics.processCount);
}

function validateSoak(soak, profile, coldProcessCount) {
  assert.ok(isRecord(soak) && Array.isArray(soak.heapTimeline), "BrainPet performance soak lacks raw heap evidence.");
  const minimumSamples = profile === "idle-24h" ? 289 : 31;
  const minimumHeapSamples = profile === "idle-24h" ? 289 : 900;
  const minimumDurationMs = profile === "idle-24h" ? 86_400_000 : 1_800_000;
  assert.ok(soak.heapTimeline.length >= minimumHeapSamples && soak.heapTimeline.every(isFiniteNonNegative), "BrainPet performance heap timeline is invalid or sparse.");
  assert.equal(soak.samples, soak.heapTimeline.length, "BrainPet performance heap sample count mismatch.");
  assert.ok(soak.durationMs >= minimumDurationMs, "BrainPet performance soak is too short.");
  assert.equal(soak.maxHeapBytes, Math.round(Math.max(...soak.heapTimeline, 0)), "BrainPet maximum heap does not match its raw timeline.");
  const warm = profile === "idle-24h" ? soak.heapTimeline : soak.heapTimeline.slice(Math.min(10, Math.floor(soak.heapTimeline.length / 3)));
  const windowSize = Math.max(1, Math.floor(warm.length / 5));
  const growth = Math.round(average(warm.slice(-windowSize)) - average(warm.slice(0, windowSize)));
  assert.equal(soak.heapGrowthBytes, growth, "BrainPet heap growth does not match its raw timeline.");
  assert.ok(growth <= 32 * MiB, "BrainPet heap growth exceeds 32 MiB.");
  const process = recomputeProcessSummary(soak.process?.timeline, soak.process?.logicalProcessorCount);
  assert.deepEqual(soak.process, process, "BrainPet process summary does not match its raw timeline.");
  assert.ok(process.samples >= minimumSamples && process.durationMs >= minimumDurationMs, "BrainPet process evidence is sparse or short.");
  assert.ok(process.maximumSampleIntervalMs <= (profile === "idle-24h" ? 310_000 : 70_000), "BrainPet process sampling gap exceeds its budget.");
  assert.ok(process.maximumProcessCount <= (profile === "idle-24h" ? 5 : coldProcessCount + 2));
  assert.ok(process.maximumTotalWorkingSetBytes <= (profile === "idle-24h" ? 400 : 650) * MiB, "BrainPet total working set exceeds its formal budget.");
  assert.ok(process.maximumWorkingSetBytes <= (profile === "idle-24h" ? 400 : 650) * MiB);
  assert.ok(process.maximumPrivateBytes <= (profile === "idle-24h" ? 400 : 650) * MiB);
  assert.ok(process.workingSetGrowthBytes < 64 * MiB);
  assert.ok(process.maximumHandleCount <= (profile === "idle-24h" ? 2_750 : 3_500));
  assert.ok(process.maximumHandleGrowth < (profile === "idle-24h" ? 128 : 256));
  if (profile === "idle-24h") assert.ok(process.maximumIntervalCpuPercent < 1);
}

function recomputeProcessSummary(samples, logicalProcessorCount) {
  assert.ok(Array.isArray(samples) && samples.length >= 2 && Number.isInteger(logicalProcessorCount) && logicalProcessorCount > 0, "BrainPet process timeline is invalid.");
  let identity = null;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    assert.ok(isRecord(sample) && Array.isArray(sample.processes) && sample.processes.length === sample.processCount && sample.processCount > 0);
    const pids = new Set();
    for (const process of sample.processes) {
      assert.ok(Number.isInteger(process.pid) && process.pid > 0 && Number.isInteger(process.parentPid) && process.parentPid >= 0 && !pids.has(process.pid) && typeof process.role === "string" && process.role && typeof process.creationTime === "string" && process.creationTime);
      pids.add(process.pid);
    }
    const root = sample.processes.find((process) => process.pid === sample.rootPid);
    assert.equal(root?.role, "browser");
    assert.ok(sample.processes.some((process) => process.role === "renderer"));
    for (const process of sample.processes) {
      if (process.pid === sample.rootPid) continue;
      const seen = new Set([process.pid]);
      let current = process;
      while (current.pid !== sample.rootPid) {
        const parent = sample.processes.find((candidate) => candidate.pid === current.parentPid);
        assert.ok(parent && !seen.has(parent.pid), "BrainPet process timeline contains an unrelated process or parent cycle.");
        seen.add(parent.pid);
        current = parent;
      }
    }
    for (const key of ["totalWorkingSetBytes", "workingSetBytes", "privateBytes", "handleCount", "cpuTime100ns"]) {
      assert.ok(sample.processes.every((process) => isFiniteNonNegative(process[key])));
      assert.equal(sample.processes.reduce((total, process) => total + process[key], 0), sample[key]);
    }
    const currentIdentity = [...sample.processes].sort((a, b) => a.pid - b.pid).map((process) => `${process.pid}@${process.creationTime}`).join(",");
    if (identity === null) identity = currentIdentity; else assert.equal(currentIdentity, identity, "BrainPet process identity changed during the soak.");
    if (index > 0) assert.ok(sample.elapsedMs > samples[index - 1].elapsedMs && sample.cpuTime100ns >= samples[index - 1].cpuTime100ns);
  }
  const first = samples[0];
  const last = samples.at(-1);
  const intervals = samples.slice(1).map((sample, index) => ({ intervalMs: sample.elapsedMs - samples[index].elapsedMs, cpuPercent: ((sample.cpuTime100ns - samples[index].cpuTime100ns) / ((sample.elapsedMs - samples[index].elapsedMs) * 10_000 * logicalProcessorCount)) * 100 }));
  const maximumHandleCount = Math.max(...samples.map((sample) => sample.handleCount));
  return { logicalProcessorCount, samples: samples.length, durationMs: last.elapsedMs - first.elapsedMs, maximumSampleIntervalMs: Math.max(...intervals.map((entry) => entry.intervalMs)), firstWorkingSetBytes: first.workingSetBytes, lastWorkingSetBytes: last.workingSetBytes, maximumWorkingSetBytes: Math.max(...samples.map((sample) => sample.workingSetBytes)), maximumTotalWorkingSetBytes: Math.max(...samples.map((sample) => sample.totalWorkingSetBytes)), workingSetGrowthBytes: last.workingSetBytes - first.workingSetBytes, maximumPrivateBytes: Math.max(...samples.map((sample) => sample.privateBytes)), maximumProcessCount: Math.max(...samples.map((sample) => sample.processCount)), firstHandleCount: first.handleCount, lastHandleCount: last.handleCount, maximumHandleCount, handleGrowth: last.handleCount - first.handleCount, maximumHandleGrowth: Math.max(0, maximumHandleCount - first.handleCount), averageCpuPercent: ((last.cpuTime100ns - first.cpuTime100ns) / ((last.elapsedMs - first.elapsedMs) * 10_000 * logicalProcessorCount)) * 100, maximumIntervalCpuPercent: Math.max(...intervals.map((entry) => entry.cpuPercent)), processIdentity: identity, timeline: samples };
}

function validateResponsiveness(summary) {
  const keys = [["coldStartup", 1_000, "max"], ["hotFeedback", 200, "max"], ["coldWake", 1_500, "max"], ["warmStageOpening", 500, "max"], ["rendererClose", 5_000, "maximum"], ["interactionFrameRate", 50, "min"]];
  for (const [key, budget, direction] of keys) {
    const entry = summary?.[key];
    assert.ok(isRecord(entry) && Array.isArray(entry.timeline) && entry.timeline.length >= 20 && entry.timeline.every(isFiniteNonNegative));
    const sorted = [...entry.timeline].sort((a, b) => a - b);
    const expected = { samples: sorted.length, minimum: sorted[0], p50: nearestRank(sorted, 0.5), p95: nearestRank(sorted, 0.95), maximum: sorted.at(-1), timeline: entry.timeline };
    assert.deepEqual(entry, expected, `BrainPet ${key} summary does not match its raw timeline.`);
    if (direction === "max") assert.ok(entry.p95 <= budget); else if (direction === "maximum") assert.ok(entry.maximum <= budget); else assert.ok(entry.p95 >= budget);
  }
  assert.ok(summary.interactionFrameRate.minimum >= 30);
}

function instantBudget(maximumProcessCount, maximumMiB, maximumHandleCount) {
  return {
    maximumProcessCount,
    maximumTotalWorkingSetBytes: maximumMiB * MiB,
    maximumWorkingSetBytes: maximumMiB * MiB,
    maximumPrivateBytes: maximumMiB * MiB,
    maximumHandleCount,
  };
}

function assertPortableRelative(value, label) { assert.ok(typeof value === "string" && value.length > 0 && value.length <= 4096 && !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value) && !value.split(/[\\/]/).includes(".."), `${label} path is invalid.`); }
function nearestRank(sorted, percentile) { return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]; }
function average(values) { return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length); }
function isFiniteNonNegative(value) { return Number.isFinite(value) && value >= 0; }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sha256Text(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
