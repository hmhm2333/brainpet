import assert from "node:assert/strict";

import { normalizeBrainPetInstantProcessMetrics } from "../../../scripts/brainpet-performance-metrics-contract.mjs";
import {
  evaluateBrainPetProcessSoakBudget,
  evaluateBrainPetResponsivenessBudget,
  summarizeBrainPetProcessSoak,
  summarizeBrainPetResponsiveness,
} from "../dist/brainpet/performance-budget.js";

export const brainPetFormalPerformanceContract = Object.freeze({
  "active-30m": Object.freeze({
    durationMs: 1_800_000,
    minimumProcessSamples: 31,
    minimumHeapSamples: 900,
    maximumProcessSampleIntervalMs: 70_000,
    minimumResponsivenessSamples: 20,
  }),
  "idle-24h": Object.freeze({
    durationMs: 86_400_000,
    minimumProcessSamples: 289,
    minimumHeapSamples: 289,
    maximumProcessSampleIntervalMs: 310_000,
  }),
});

export function normalizeBrainPetFormalGateResult(gateResult, gateProfile) {
  assert.ok(gateResult && typeof gateResult === "object" && !Array.isArray(gateResult), "BrainPet formal performance result is missing.");
  assert.equal(gateResult.ok, true, "BrainPet formal performance result did not succeed.");
  assert.equal(gateResult.gateProfile, gateProfile, "BrainPet formal performance result profile is invalid.");
  assert.equal(gateResult.gatePassed, true, "BrainPet formal performance result cannot be a probe.");
  assert.equal(gateResult.resourceBudgetEnforced, true, "BrainPet formal performance result disabled its resource budget.");
  if (gateProfile === "idle-24h") return normalizeIdleResult(gateResult);
  if (gateProfile === "active-30m") return normalizeActiveResult(gateResult);
  throw new Error(`Unknown formal BrainPet performance profile: ${gateProfile}`);
}

export function validateBrainPetFormalGateResult(gateResult, gateProfile) {
  const normalized = normalizeBrainPetFormalGateResult(gateResult, gateProfile);
  assert.deepEqual(gateResult, normalized, "BrainPet performance receipt contains non-canonical or unvalidated result fields.");
  return normalized;
}

function normalizeIdleResult(result) {
  assertFinitePositive(result.petReadyMs, "idle pet-ready latency");
  assert.deepEqual(result.rendererTargetTitles, ["BrainPet Default Pet"], "Idle gate must retain exactly the default pet renderer.");
  const idleProcessMetrics = normalizeBrainPetInstantProcessMetrics(result.idleProcessMetrics, "idle baseline", instantBudget({ maximumProcessCount: 5, maximumMiB: 400, maximumHandleCount: 2_750 }));
  const idleSoak = normalizeSoak(result.idleSoak, "idle-24h");
  assert.ok(idleSoak.heapGrowthBytes <= 32 * 1024 * 1024, "Idle renderer heap growth exceeds 32 MiB.");
  return {
    ok: true,
    gateProfile: "idle-24h",
    gatePassed: true,
    resourceBudgetEnforced: true,
    petReadyMs: result.petReadyMs,
    rendererTargetTitles: ["BrainPet Default Pet"],
    idleProcessMetrics,
    idleSoak,
  };
}

function normalizeActiveResult(result) {
  assert.equal(result.taskId, "cargo-signal", "Active performance gate must run the production cargo-signal task.");
  assertFinitePositive(result.petReadyMs, "active pet-ready latency");
  assert.equal(result.crashIsolated, true, "Active performance gate did not isolate the intentional renderer crash.");
  assert.equal(result.crashRecovered, true, "Active performance gate did not recover from the intentional renderer crash.");
  assert.equal(result.companionVerified, true, "Active performance gate did not verify companion rendering.");
  assert.equal(result.petToggleCloseVerified, true, "Active performance gate did not verify renderer close/replacement.");
  const idleProcessMetrics = normalizeBrainPetInstantProcessMetrics(result.idleProcessMetrics, "cold idle", instantBudget({ maximumProcessCount: 5, maximumMiB: 400, maximumHandleCount: 2_750 }));
  const activeProcessMetrics = normalizeBrainPetInstantProcessMetrics(result.activeProcessMetrics, "active", instantBudget({ maximumProcessCount: idleProcessMetrics.processCount + 2, maximumMiB: 650, maximumHandleCount: 3_500 }));
  const hotIdleProcessMetrics = normalizeBrainPetInstantProcessMetrics(result.hotIdleProcessMetrics, "hot idle", instantBudget({ maximumProcessCount: idleProcessMetrics.processCount + 1, maximumMiB: 500, maximumHandleCount: 3_500 }));
  const recoveredIdleProcessMetrics = normalizeBrainPetInstantProcessMetrics(result.recoveredIdleProcessMetrics, "recovered idle", instantBudget({ maximumProcessCount: idleProcessMetrics.processCount + 1, maximumMiB: 500, maximumHandleCount: 3_500 }));
  assert.ok(hotIdleProcessMetrics.totalWorkingSetBytes - idleProcessMetrics.totalWorkingSetBytes <= 100 * 1024 * 1024, "Active performance gate retained more than 100 MiB total working set above cold idle.");
  assert.ok(recoveredIdleProcessMetrics.totalWorkingSetBytes - idleProcessMetrics.totalWorkingSetBytes <= 100 * 1024 * 1024, "Recovered performance gate retained more than 100 MiB total working set above cold idle.");
  const responsiveness = normalizeResponsiveness(result.responsiveness);
  const soak = normalizeSoak(result.soak, "active-30m", idleProcessMetrics.processCount);
  assert.ok(soak.heapGrowthBytes <= 32 * 1024 * 1024, "Active renderer heap growth exceeds 32 MiB.");
  return {
    ok: true,
    gateProfile: "active-30m",
    gatePassed: true,
    taskId: "cargo-signal",
    resourceBudgetEnforced: true,
    petReadyMs: result.petReadyMs,
    responsiveness,
    idleProcessMetrics,
    activeProcessMetrics,
    hotIdleProcessMetrics,
    recoveredIdleProcessMetrics,
    companionVerified: true,
    petToggleCloseVerified: true,
    soak,
    crashIsolated: true,
    crashRecovered: true,
  };
}

function normalizeResponsiveness(summary) {
  assert.ok(summary && typeof summary === "object" && !Array.isArray(summary), "Active performance receipt lacks responsiveness evidence.");
  const raw = {
    coldStartupMs: summary.coldStartup?.timeline,
    hotFeedbackMs: summary.hotFeedback?.timeline,
    coldWakeMs: summary.coldWake?.timeline,
    warmStageOpeningMs: summary.warmStageOpening?.timeline,
    rendererCloseMs: summary.rendererClose?.timeline,
    interactionFrameRateFps: summary.interactionFrameRate?.timeline,
  };
  const recomputed = summarizeBrainPetResponsiveness(raw);
  assert.deepEqual(summary, recomputed, "BrainPet responsiveness summary does not match its raw timelines.");
  const violations = evaluateBrainPetResponsivenessBudget(recomputed, {
    minimumSamples: brainPetFormalPerformanceContract["active-30m"].minimumResponsivenessSamples,
    maximumColdStartupP95Ms: 1_000,
    maximumHotFeedbackP95Ms: 200,
    maximumColdWakeP95Ms: 1_500,
    maximumWarmStageOpeningP95Ms: 500,
    maximumRendererCloseMs: 5_000,
    minimumInteractionFrameRateP95Fps: 50,
    minimumInteractionFrameRateFps: 30,
  });
  assert.deepEqual(violations, [], `BrainPet responsiveness receipt violates its formal budget: ${violations.join("; ")}`);
  return recomputed;
}

function normalizeSoak(soak, profile, coldIdleProcessCount = null) {
  assert.ok(soak && typeof soak === "object" && !Array.isArray(soak), "BrainPet performance receipt lacks soak evidence.");
  const contract = brainPetFormalPerformanceContract[profile];
  assert.ok(Array.isArray(soak.heapTimeline) && soak.heapTimeline.length >= contract.minimumHeapSamples, "BrainPet performance receipt lacks raw heap samples.");
  for (const value of soak.heapTimeline) assertFiniteNonNegative(value, "renderer heap sample");
  assert.equal(soak.samples, soak.heapTimeline.length, "BrainPet soak heap sample count does not match its timeline.");
  assert.ok(soak.durationMs >= contract.durationMs, "BrainPet soak duration is shorter than the formal profile.");
  assert.equal(soak.maxHeapBytes, Math.round(Math.max(...soak.heapTimeline, 0)), "BrainPet soak maximum heap does not match its timeline.");
  const expectedHeapGrowth = profile === "idle-24h" ? idleHeapGrowth(soak.heapTimeline) : activeHeapGrowth(soak.heapTimeline);
  assert.equal(soak.heapGrowthBytes, expectedHeapGrowth, "BrainPet soak heap growth does not match its raw samples.");
  assert.ok(soak.process && Array.isArray(soak.process.timeline), "BrainPet soak lacks a raw process timeline.");
  const recomputed = summarizeBrainPetProcessSoak(soak.process.timeline, soak.process.logicalProcessorCount);
  assert.deepEqual(soak.process, recomputed, "BrainPet process summary does not match its raw timeline.");
  const maximumProcessCount = profile === "idle-24h" ? 5 : coldIdleProcessCount + 2;
  const violations = evaluateBrainPetProcessSoakBudget(recomputed, {
    maximumProcessCount,
    maximumTotalWorkingSetBytes: (profile === "idle-24h" ? 400 : 650) * 1024 * 1024,
    maximumWorkingSetBytes: (profile === "idle-24h" ? 400 : 650) * 1024 * 1024,
    maximumPrivateBytes: (profile === "idle-24h" ? 400 : 650) * 1024 * 1024,
    maximumWorkingSetGrowthBytes: 64 * 1024 * 1024,
    maximumHandleCount: profile === "idle-24h" ? 2_750 : 3_500,
    maximumHandleGrowth: profile === "idle-24h" ? 128 : 256,
    minimumSamples: contract.minimumProcessSamples,
    minimumDurationMs: contract.durationMs,
    maximumSampleIntervalMs: contract.maximumProcessSampleIntervalMs,
    ...(profile === "idle-24h" ? { maximumIntervalCpuPercent: 1 } : {}),
  });
  assert.deepEqual(violations, [], `BrainPet process receipt violates its formal budget: ${violations.join("; ")}`);
  return {
    durationMs: soak.durationMs,
    samples: soak.samples,
    ...(profile === "active-30m" ? { sessions: soak.sessions } : {}),
    heapGrowthBytes: soak.heapGrowthBytes,
    maxHeapBytes: soak.maxHeapBytes,
    heapTimeline: soak.heapTimeline,
    process: recomputed,
  };
}

function instantBudget({ maximumProcessCount, maximumMiB, maximumHandleCount }) {
  return {
    maximumProcessCount,
    maximumTotalWorkingSetBytes: maximumMiB * 1024 * 1024,
    maximumWorkingSetBytes: maximumMiB * 1024 * 1024,
    maximumPrivateBytes: maximumMiB * 1024 * 1024,
    maximumHandleCount,
  };
}

function activeHeapGrowth(samples) {
  const warm = samples.slice(Math.min(10, Math.floor(samples.length / 3)));
  const windowSize = Math.max(1, Math.floor(warm.length / 5));
  return Math.round(average(warm.slice(-windowSize)) - average(warm.slice(0, windowSize)));
}

function idleHeapGrowth(samples) {
  const windowSize = Math.max(1, Math.floor(samples.length / 5));
  return Math.round(average(samples.slice(-windowSize)) - average(samples.slice(0, windowSize)));
}

function average(values) {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function assertFinitePositive(value, label) {
  assert.ok(Number.isFinite(value) && value > 0, `BrainPet ${label} is invalid.`);
}

function assertFiniteNonNegative(value, label) {
  assert.ok(Number.isFinite(value) && value >= 0, `BrainPet ${label} is invalid.`);
}
