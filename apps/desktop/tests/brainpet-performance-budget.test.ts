import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBrainPetProcessSoakBudget, summarizeBrainPetProcessSoak, type BrainPetProcessMetricsSample } from "../src/brainpet/performance-budget.js";

const MiB = 1024 * 1024;

test("long-soak process evidence records memory, process, handle and normalized CPU trends", () => {
  const samples: BrainPetProcessMetricsSample[] = [
    { elapsedMs: 0, processCount: 6, workingSetBytes: 560 * MiB, privateBytes: 260 * MiB, handleCount: 2_900, cpuTime100ns: 10_000_000 },
    { elapsedMs: 900_000, processCount: 6, workingSetBytes: 585 * MiB, privateBytes: 280 * MiB, handleCount: 2_940, cpuTime100ns: 50_000_000 },
    { elapsedMs: 1_800_000, processCount: 6, workingSetBytes: 590 * MiB, privateBytes: 282 * MiB, handleCount: 2_960, cpuTime100ns: 90_000_000 },
  ];
  const summary = summarizeBrainPetProcessSoak(samples, 8);
  assert.equal(summary.samples, 3);
  assert.equal(summary.workingSetGrowthBytes, 30 * MiB);
  assert.equal(summary.maximumHandleCount, 2_960);
  assert.equal(summary.handleGrowth, 60);
  assert.ok(summary.averageCpuPercent > 0 && summary.averageCpuPercent < 1);
  assert.ok(summary.maximumIntervalCpuPercent > 0 && summary.maximumIntervalCpuPercent < 1);
  assert.deepEqual(evaluateBrainPetProcessSoakBudget(summary, {
    maximumProcessCount: 6,
    maximumWorkingSetBytes: 650 * MiB,
    maximumPrivateBytes: 650 * MiB,
    maximumWorkingSetGrowthBytes: 64 * MiB,
    maximumIntervalCpuPercent: 1,
  }), []);
});

test("long-soak process budget rejects a transient peak and continuing growth", () => {
  const samples: BrainPetProcessMetricsSample[] = [
    { elapsedMs: 0, processCount: 6, workingSetBytes: 580 * MiB, privateBytes: 250 * MiB, handleCount: 2_900, cpuTime100ns: 0 },
    { elapsedMs: 900_000, processCount: 7, workingSetBytes: 670 * MiB, privateBytes: 660 * MiB, handleCount: 3_000, cpuTime100ns: 20_000_000 },
    { elapsedMs: 1_800_000, processCount: 6, workingSetBytes: 645 * MiB, privateBytes: 300 * MiB, handleCount: 3_100, cpuTime100ns: 40_000_000 },
  ];
  const violations = evaluateBrainPetProcessSoakBudget(summarizeBrainPetProcessSoak(samples, 8), {
    maximumProcessCount: 6,
    maximumWorkingSetBytes: 650 * MiB,
    maximumPrivateBytes: 650 * MiB,
    maximumWorkingSetGrowthBytes: 64 * MiB,
    maximumIntervalCpuPercent: 0.01,
  });
  assert.deepEqual(violations, [
    "process count 7 exceeds 6",
    `working set ${670 * MiB} exceeds ${650 * MiB}`,
    `private bytes ${660 * MiB} exceeds ${650 * MiB}`,
    `working set growth ${65 * MiB} is not below ${64 * MiB}`,
    "maximum interval CPU 0.028% is not below 0.01%",
  ]);
});

test("idle CPU budget rejects a busy sample interval hidden by a low whole-run average", () => {
  const samples: BrainPetProcessMetricsSample[] = [
    { elapsedMs: 0, processCount: 4, workingSetBytes: 300 * MiB, privateBytes: 180 * MiB, handleCount: 2_000, cpuTime100ns: 0 },
    { elapsedMs: 300_000, processCount: 4, workingSetBytes: 302 * MiB, privateBytes: 181 * MiB, handleCount: 2_005, cpuTime100ns: 480_000_000 },
    { elapsedMs: 3_600_000, processCount: 4, workingSetBytes: 303 * MiB, privateBytes: 182 * MiB, handleCount: 2_010, cpuTime100ns: 480_000_000 },
  ];
  const summary = summarizeBrainPetProcessSoak(samples, 8);
  assert.ok(summary.averageCpuPercent < 1);
  assert.equal(summary.maximumIntervalCpuPercent, 2);
  assert.deepEqual(evaluateBrainPetProcessSoakBudget(summary, {
    maximumProcessCount: 5,
    maximumWorkingSetBytes: 400 * MiB,
    maximumPrivateBytes: 400 * MiB,
    maximumWorkingSetGrowthBytes: 64 * MiB,
    maximumIntervalCpuPercent: 1,
  }), ["maximum interval CPU 2.000% is not below 1%"]);
});

test("long-soak evidence rejects a restarted process tree that resets cumulative CPU", () => {
  assert.throws(() => summarizeBrainPetProcessSoak([
    { elapsedMs: 0, processCount: 4, workingSetBytes: 300 * MiB, privateBytes: 180 * MiB, handleCount: 2_000, cpuTime100ns: 20_000_000 },
    { elapsedMs: 60_000, processCount: 4, workingSetBytes: 310 * MiB, privateBytes: 185 * MiB, handleCount: 2_010, cpuTime100ns: 10_000_000 },
  ], 8), /must not move backwards or reset/i);
});
