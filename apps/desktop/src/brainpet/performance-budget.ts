export interface BrainPetProcessMetricsSample {
  elapsedMs: number;
  processCount: number;
  workingSetBytes: number;
  privateBytes: number;
  handleCount: number;
  cpuTime100ns: number;
}

export interface BrainPetProcessSoakSummary {
  samples: number;
  durationMs: number;
  firstWorkingSetBytes: number;
  lastWorkingSetBytes: number;
  maximumWorkingSetBytes: number;
  workingSetGrowthBytes: number;
  maximumPrivateBytes: number;
  maximumProcessCount: number;
  firstHandleCount: number;
  lastHandleCount: number;
  maximumHandleCount: number;
  handleGrowth: number;
  averageCpuPercent: number;
  maximumIntervalCpuPercent: number;
}

export interface BrainPetProcessSoakBudget {
  maximumProcessCount: number;
  maximumWorkingSetBytes: number;
  maximumPrivateBytes: number;
  maximumWorkingSetGrowthBytes: number;
  maximumIntervalCpuPercent?: number;
}

export function summarizeBrainPetProcessSoak(
  samples: readonly BrainPetProcessMetricsSample[],
  logicalProcessorCount: number,
): BrainPetProcessSoakSummary {
  if (!Number.isInteger(logicalProcessorCount) || logicalProcessorCount <= 0) throw new Error("BrainPet process soak requires a positive logical processor count.");
  if (samples.length < 2) throw new Error("BrainPet process soak requires at least two samples.");
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    for (const [key, value] of Object.entries(sample)) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`BrainPet process soak sample ${index} has invalid ${key}.`);
    }
    if (index > 0 && sample.elapsedMs <= samples[index - 1].elapsedMs) throw new Error("BrainPet process soak samples must have strictly increasing elapsed times.");
    if (index > 0 && sample.cpuTime100ns < samples[index - 1].cpuTime100ns) throw new Error("BrainPet process soak CPU time must not move backwards or reset during the run.");
  }
  const first = samples[0];
  const last = samples.at(-1)!;
  const durationMs = last.elapsedMs - first.elapsedMs;
  const cpuTimeDelta100ns = Math.max(0, last.cpuTime100ns - first.cpuTime100ns);
  const intervalCpuPercentages = samples.slice(1).map((sample, index) => {
    const previous = samples[index];
    const intervalMs = sample.elapsedMs - previous.elapsedMs;
    const intervalCpuTime100ns = sample.cpuTime100ns - previous.cpuTime100ns;
    return (intervalCpuTime100ns / (intervalMs * 10_000 * logicalProcessorCount)) * 100;
  });
  return {
    samples: samples.length,
    durationMs,
    firstWorkingSetBytes: first.workingSetBytes,
    lastWorkingSetBytes: last.workingSetBytes,
    maximumWorkingSetBytes: Math.max(...samples.map((sample) => sample.workingSetBytes)),
    workingSetGrowthBytes: last.workingSetBytes - first.workingSetBytes,
    maximumPrivateBytes: Math.max(...samples.map((sample) => sample.privateBytes)),
    maximumProcessCount: Math.max(...samples.map((sample) => sample.processCount)),
    firstHandleCount: first.handleCount,
    lastHandleCount: last.handleCount,
    maximumHandleCount: Math.max(...samples.map((sample) => sample.handleCount)),
    handleGrowth: last.handleCount - first.handleCount,
    averageCpuPercent: durationMs === 0 ? 0 : (cpuTimeDelta100ns / (durationMs * 10_000 * logicalProcessorCount)) * 100,
    maximumIntervalCpuPercent: Math.max(...intervalCpuPercentages),
  };
}

export function evaluateBrainPetProcessSoakBudget(
  summary: BrainPetProcessSoakSummary,
  budget: BrainPetProcessSoakBudget,
): string[] {
  const violations: string[] = [];
  if (summary.maximumProcessCount > budget.maximumProcessCount) violations.push(`process count ${summary.maximumProcessCount} exceeds ${budget.maximumProcessCount}`);
  if (summary.maximumWorkingSetBytes > budget.maximumWorkingSetBytes) violations.push(`working set ${summary.maximumWorkingSetBytes} exceeds ${budget.maximumWorkingSetBytes}`);
  if (summary.maximumPrivateBytes > budget.maximumPrivateBytes) violations.push(`private bytes ${summary.maximumPrivateBytes} exceeds ${budget.maximumPrivateBytes}`);
  if (summary.workingSetGrowthBytes >= budget.maximumWorkingSetGrowthBytes) violations.push(`working set growth ${summary.workingSetGrowthBytes} is not below ${budget.maximumWorkingSetGrowthBytes}`);
  if (budget.maximumIntervalCpuPercent !== undefined && summary.maximumIntervalCpuPercent >= budget.maximumIntervalCpuPercent) violations.push(`maximum interval CPU ${summary.maximumIntervalCpuPercent.toFixed(3)}% is not below ${budget.maximumIntervalCpuPercent}%`);
  return violations;
}
