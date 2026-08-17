import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBrainPetProcessSoakBudget, evaluateBrainPetResponsivenessBudget, summarizeBrainPetProcessSoak, summarizeBrainPetResponsiveness, type BrainPetProcessMetricsSample } from "../src/brainpet/performance-budget.js";

const MiB = 1024 * 1024;

function sample(elapsedMs: number, values: { processCount?: number; workingSetBytes: number; privateBytes: number; handleCount: number; cpuTime100ns: number; identityOffset?: number }): BrainPetProcessMetricsSample {
  const processCount = values.processCount ?? 2;
  const identityOffset = values.identityOffset ?? 0;
  const processes = Array.from({ length: processCount }, (_, index) => ({
    pid: 100 + identityOffset + index,
    parentPid: index === 0 ? 1 : 100 + identityOffset,
    role: index === 0 ? "browser" : "renderer",
    creationTime: `2026-08-16T00:00:${String(identityOffset).padStart(2, "0")}.000Z`,
    totalWorkingSetBytes: index === 0 ? values.workingSetBytes + 100 * MiB - (processCount - 1) : 1,
    workingSetBytes: index === 0 ? values.workingSetBytes - (processCount - 1) : 1,
    privateBytes: index === 0 ? values.privateBytes - (processCount - 1) : 1,
    handleCount: index === 0 ? values.handleCount - (processCount - 1) : 1,
    cpuTime100ns: index === 0 ? values.cpuTime100ns : 0,
  }));
  return { elapsedMs, rootPid: 100 + identityOffset, processCount, totalWorkingSetBytes: values.workingSetBytes + 100 * MiB, workingSetBytes: values.workingSetBytes, privateBytes: values.privateBytes, handleCount: values.handleCount, cpuTime100ns: values.cpuTime100ns, processes };
}

const normalBudget = {
  maximumProcessCount: 6,
  maximumWorkingSetBytes: 650 * MiB,
  maximumPrivateBytes: 650 * MiB,
  maximumWorkingSetGrowthBytes: 64 * MiB,
  maximumHandleCount: 3_500,
  maximumHandleGrowth: 256,
  minimumSamples: 3,
  minimumDurationMs: 1_800_000,
  maximumSampleIntervalMs: 900_000,
  maximumIntervalCpuPercent: 1,
};

test("long-soak evidence records an auditable stable process timeline", () => {
  const samples = [
    sample(0, { processCount: 6, workingSetBytes: 560 * MiB, privateBytes: 260 * MiB, handleCount: 2_900, cpuTime100ns: 10_000_000 }),
    sample(900_000, { processCount: 6, workingSetBytes: 585 * MiB, privateBytes: 280 * MiB, handleCount: 2_940, cpuTime100ns: 50_000_000 }),
    sample(1_800_000, { processCount: 6, workingSetBytes: 590 * MiB, privateBytes: 282 * MiB, handleCount: 2_960, cpuTime100ns: 90_000_000 }),
  ];
  const summary = summarizeBrainPetProcessSoak(samples, 8);
  assert.equal(summary.timeline, samples);
  assert.equal(summary.maximumSampleIntervalMs, 900_000);
  assert.equal(summary.workingSetGrowthBytes, 30 * MiB);
  assert.equal(summary.maximumTotalWorkingSetBytes, 690 * MiB);
  assert.equal(summary.maximumHandleCount, 2_960);
  assert.equal(summary.handleGrowth, 60);
  assert.equal(summary.maximumHandleGrowth, 60);
  assert.ok(summary.processIdentity.includes("100@"));
  assert.deepEqual(evaluateBrainPetProcessSoakBudget(summary, normalBudget), []);
});

test("budget rejects transient resource peaks, handle leakage and continuing growth", () => {
  const samples = [
    sample(0, { processCount: 6, workingSetBytes: 580 * MiB, privateBytes: 250 * MiB, handleCount: 2_900, cpuTime100ns: 0 }),
    sample(900_000, { processCount: 6, workingSetBytes: 670 * MiB, privateBytes: 660 * MiB, handleCount: 100_000, cpuTime100ns: 20_000_000 }),
    sample(1_800_000, { processCount: 6, workingSetBytes: 645 * MiB, privateBytes: 300 * MiB, handleCount: 3_100, cpuTime100ns: 40_000_000 }),
  ];
  const violations = evaluateBrainPetProcessSoakBudget(summarizeBrainPetProcessSoak(samples, 8), normalBudget);
  assert.ok(violations.some((value) => value.startsWith("working set")));
  assert.ok(violations.some((value) => value.startsWith("private bytes")));
  assert.ok(violations.some((value) => value.startsWith("handle count")));
  assert.ok(violations.some((value) => value.startsWith("peak handle growth")));
});

test("idle CPU budget rejects a busy sample interval hidden by a low whole-run average", () => {
  const samples = [
    sample(0, { workingSetBytes: 300 * MiB, privateBytes: 180 * MiB, handleCount: 2_000, cpuTime100ns: 0 }),
    sample(300_000, { workingSetBytes: 302 * MiB, privateBytes: 181 * MiB, handleCount: 2_005, cpuTime100ns: 480_000_000 }),
    sample(3_600_000, { workingSetBytes: 303 * MiB, privateBytes: 182 * MiB, handleCount: 2_010, cpuTime100ns: 480_000_000 }),
  ];
  const summary = summarizeBrainPetProcessSoak(samples, 8);
  assert.ok(summary.averageCpuPercent < 1);
  assert.equal(summary.maximumIntervalCpuPercent, 2);
  assert.ok(evaluateBrainPetProcessSoakBudget(summary, { ...normalBudget, minimumDurationMs: 0, maximumSampleIntervalMs: 4_000_000 }).some((value) => value.includes("maximum interval CPU")));
});

test("empty, inconsistent and replaced process trees fail closed", () => {
  const valid = sample(0, { workingSetBytes: 300 * MiB, privateBytes: 180 * MiB, handleCount: 2_000, cpuTime100ns: 20_000_000 });
  const later = sample(60_000, { workingSetBytes: 310 * MiB, privateBytes: 185 * MiB, handleCount: 2_010, cpuTime100ns: 30_000_000 });
  assert.throws(() => summarizeBrainPetProcessSoak([{ ...valid, processCount: 0, workingSetBytes: 0, privateBytes: 0, handleCount: 0, processes: [] }, { ...later, processCount: 0, workingSetBytes: 0, privateBytes: 0, handleCount: 0, processes: [] }], 8), /non-empty process tree/i);
  assert.throws(() => summarizeBrainPetProcessSoak([valid, { ...later, workingSetBytes: later.workingSetBytes + 1 }], 8), /aggregate does not match/i);
  assert.throws(
    () => summarizeBrainPetProcessSoak([valid, sample(60_000, { workingSetBytes: 310 * MiB, privateBytes: 185 * MiB, handleCount: 2_010, cpuTime100ns: 30_000_000, identityOffset: 20 })], 8),
    /identity changed.*sample 1 \(60000\.0 ms\).*expected 100@.*received 120@/i,
  );
  assert.throws(() => summarizeBrainPetProcessSoak([valid, { ...later, cpuTime100ns: 10_000_000, processes: later.processes.map((process) => ({ ...process, cpuTime100ns: process.pid === later.rootPid ? 10_000_000 : 0 })) }], 8), /must not move backwards/i);
  const unrelated = { ...later, processes: later.processes.map((process) => process.pid === later.rootPid ? process : { ...process, parentPid: 999 }) };
  assert.throws(() => summarizeBrainPetProcessSoak([valid, unrelated], 8), /outside the root tree/i);
  const cyclic = { ...later, processes: later.processes.map((process) => process.pid === later.rootPid ? process : { ...process, parentPid: process.pid }) };
  assert.throws(() => summarizeBrainPetProcessSoak([valid, cyclic], 8), /parent cycle/i);
});

test("continuity and strict threshold boundaries cannot be weakened", () => {
  const exact = [
    sample(0, { processCount: 6, workingSetBytes: 586 * MiB, privateBytes: 300 * MiB, handleCount: 3_244, cpuTime100ns: 0 }),
    sample(900_000, { processCount: 6, workingSetBytes: 650 * MiB, privateBytes: 650 * MiB, handleCount: 3_500, cpuTime100ns: 720_000_000 }),
    sample(1_800_000, { processCount: 6, workingSetBytes: 650 * MiB, privateBytes: 650 * MiB, handleCount: 3_500, cpuTime100ns: 1_440_000_000 }),
  ];
  const violations = evaluateBrainPetProcessSoakBudget(summarizeBrainPetProcessSoak(exact, 8), normalBudget);
  assert.equal(violations.some((value) => value.startsWith("process count")), false, "process count exactly at the ceiling is allowed");
  assert.equal(violations.some((value) => value.startsWith("working set ") && !value.startsWith("working set growth")), false, "working set exactly at the ceiling is allowed");
  assert.ok(violations.some((value) => value.startsWith("working set growth")), "growth exactly 64 MiB must fail");
  assert.ok(violations.some((value) => value.startsWith("peak handle growth")), "handle growth exactly 256 must fail");
  assert.ok(violations.some((value) => value.includes("maximum interval CPU 1.000%")), "CPU exactly 1% must fail");
  assert.ok(evaluateBrainPetProcessSoakBudget(summarizeBrainPetProcessSoak([exact[0], { ...exact[1], elapsedMs: 1_000_000 }, { ...exact[2], elapsedMs: 1_900_000 }], 8), normalBudget).some((value) => value.startsWith("sample interval")), "a sampling gap must fail");
  assert.ok(evaluateBrainPetProcessSoakBudget(summarizeBrainPetProcessSoak(exact.slice(0, 2), 8), normalBudget).some((value) => value.startsWith("sample count")), "too few samples must fail");
});

const responsivenessBudget = {
  minimumSamples: 20,
  maximumColdStartupP95Ms: 1_000,
  maximumHotFeedbackP95Ms: 200,
  maximumColdWakeP95Ms: 1_500,
  maximumWarmStageOpeningP95Ms: 500,
  maximumRendererCloseMs: 5_000,
  minimumInteractionFrameRateP95Fps: 50,
  minimumInteractionFrameRateFps: 30,
};

test("responsiveness evidence uses auditable nearest-rank percentiles", () => {
  const nineteen = (value: number) => Array.from({ length: 19 }, () => value);
  const summary = summarizeBrainPetResponsiveness({
    coldStartupMs: [...nineteen(1_000), 1_400],
    hotFeedbackMs: [...nineteen(200), 350],
    coldWakeMs: [...nineteen(1_500), 2_000],
    warmStageOpeningMs: [...nineteen(500), 700],
    rendererCloseMs: [...nineteen(250), 5_000],
    interactionFrameRateFps: [30, ...Array.from({ length: 18 }, () => 50), 60],
  });
  assert.equal(summary.coldStartup.p95, 1_000);
  assert.equal(summary.coldStartup.maximum, 1_400);
  assert.equal(summary.interactionFrameRate.minimum, 30);
  assert.equal(summary.interactionFrameRate.p95, 50);
  assert.deepEqual(evaluateBrainPetResponsivenessBudget(summary, responsivenessBudget), []);
});

test("responsiveness budget fails closed for sparse, slow, or janky evidence", () => {
  const summary = summarizeBrainPetResponsiveness({
    coldStartupMs: Array.from({ length: 19 }, () => 1_001),
    hotFeedbackMs: Array.from({ length: 19 }, () => 201),
    coldWakeMs: Array.from({ length: 19 }, () => 1_501),
    warmStageOpeningMs: Array.from({ length: 19 }, () => 501),
    rendererCloseMs: [...Array.from({ length: 18 }, () => 250), 5_001],
    interactionFrameRateFps: [29, ...Array.from({ length: 18 }, () => 49)],
  });
  const violations = evaluateBrainPetResponsivenessBudget(summary, responsivenessBudget);
  assert.ok(violations.some((value) => value.includes("sample count")));
  assert.ok(violations.some((value) => value.startsWith("cold startup p95")));
  assert.ok(violations.some((value) => value.startsWith("hot feedback p95")));
  assert.ok(violations.some((value) => value.startsWith("cold wake p95")));
  assert.ok(violations.some((value) => value.startsWith("warm stage opening p95")));
  assert.ok(violations.some((value) => value.startsWith("renderer close maximum")));
  assert.ok(violations.some((value) => value.startsWith("interaction frame rate p95")));
  assert.ok(violations.some((value) => value.startsWith("interaction frame rate minimum")));
  assert.throws(() => summarizeBrainPetResponsiveness({ coldStartupMs: [], hotFeedbackMs: [1], coldWakeMs: [1], warmStageOpeningMs: [1], rendererCloseMs: [1], interactionFrameRateFps: [1] }), /requires at least one sample/i);
  assert.throws(() => summarizeBrainPetResponsiveness({ coldStartupMs: [Number.NaN], hotFeedbackMs: [1], coldWakeMs: [1], warmStageOpeningMs: [1], rendererCloseMs: [1], interactionFrameRateFps: [1] }), /sample 0 is invalid/i);
});
