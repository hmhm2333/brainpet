export interface BrainPetProcessDetail {
  pid: number;
  parentPid: number;
  role: string;
  creationTime: string;
  totalWorkingSetBytes: number;
  workingSetBytes: number;
  privateBytes: number;
  handleCount: number;
  cpuTime100ns: number;
}

export interface BrainPetProcessMetricsSample {
  elapsedMs: number;
  rootPid: number;
  processCount: number;
  totalWorkingSetBytes: number;
  workingSetBytes: number;
  privateBytes: number;
  handleCount: number;
  cpuTime100ns: number;
  processes: readonly BrainPetProcessDetail[];
}

export interface BrainPetProcessSoakSummary {
  logicalProcessorCount: number;
  samples: number;
  durationMs: number;
  maximumSampleIntervalMs: number;
  firstWorkingSetBytes: number;
  lastWorkingSetBytes: number;
  maximumWorkingSetBytes: number;
  maximumTotalWorkingSetBytes: number;
  workingSetGrowthBytes: number;
  maximumPrivateBytes: number;
  maximumProcessCount: number;
  firstHandleCount: number;
  lastHandleCount: number;
  maximumHandleCount: number;
  handleGrowth: number;
  maximumHandleGrowth: number;
  averageCpuPercent: number;
  maximumIntervalCpuPercent: number;
  processIdentity: string;
  timeline: readonly BrainPetProcessMetricsSample[];
}

export interface BrainPetProcessSoakBudget {
  maximumProcessCount: number;
  maximumTotalWorkingSetBytes: number;
  maximumWorkingSetBytes: number;
  maximumPrivateBytes: number;
  maximumWorkingSetGrowthBytes: number;
  maximumHandleCount: number;
  maximumHandleGrowth: number;
  minimumSamples: number;
  minimumDurationMs: number;
  maximumSampleIntervalMs: number;
  maximumIntervalCpuPercent?: number;
}

export interface BrainPetPercentileSummary {
  samples: number;
  minimum: number;
  p50: number;
  p95: number;
  maximum: number;
  timeline: readonly number[];
}

export interface BrainPetResponsivenessEvidence {
  coldStartupMs: readonly number[];
  hotFeedbackMs: readonly number[];
  coldWakeMs: readonly number[];
  warmStageOpeningMs: readonly number[];
  rendererCloseMs: readonly number[];
  interactionFrameRateFps: readonly number[];
}

export interface BrainPetResponsivenessSummary {
  coldStartup: BrainPetPercentileSummary;
  hotFeedback: BrainPetPercentileSummary;
  coldWake: BrainPetPercentileSummary;
  warmStageOpening: BrainPetPercentileSummary;
  rendererClose: BrainPetPercentileSummary;
  interactionFrameRate: BrainPetPercentileSummary;
}

export interface BrainPetResponsivenessBudget {
  minimumSamples: number;
  maximumColdStartupP95Ms: number;
  maximumHotFeedbackP95Ms: number;
  maximumColdWakeP95Ms: number;
  maximumWarmStageOpeningP95Ms: number;
  maximumRendererCloseMs: number;
  minimumInteractionFrameRateP95Fps: number;
  minimumInteractionFrameRateFps: number;
}

export function summarizeBrainPetProcessSoak(samples: readonly BrainPetProcessMetricsSample[], logicalProcessorCount: number): BrainPetProcessSoakSummary {
  if (!Number.isInteger(logicalProcessorCount) || logicalProcessorCount <= 0) throw new Error("BrainPet process soak requires a positive logical processor count.");
  if (samples.length < 2) throw new Error("BrainPet process soak requires at least two samples.");
  let expectedIdentity = "";
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    for (const key of ["elapsedMs", "rootPid", "processCount", "totalWorkingSetBytes", "workingSetBytes", "privateBytes", "handleCount", "cpuTime100ns"] as const) {
      const value = sample[key];
      if (!Number.isFinite(value) || value < 0) throw new Error(`BrainPet process soak sample ${index} has invalid ${key}.`);
    }
    if (!Number.isInteger(sample.rootPid) || sample.rootPid <= 0) throw new Error(`BrainPet process soak sample ${index} has invalid rootPid.`);
    if (!Number.isInteger(sample.processCount) || sample.processCount <= 0) throw new Error(`BrainPet process soak sample ${index} must contain a non-empty process tree.`);
    if (sample.workingSetBytes <= 0 || sample.privateBytes <= 0 || sample.handleCount <= 0) throw new Error(`BrainPet process soak sample ${index} has empty resource evidence.`);
    if (!Array.isArray(sample.processes) || sample.processes.length !== sample.processCount) throw new Error(`BrainPet process soak sample ${index} process detail count does not match its process count.`);
    const pids = new Set<number>();
    for (const process of sample.processes) {
      if (!Number.isInteger(process.pid) || process.pid <= 0 || !Number.isInteger(process.parentPid) || process.parentPid < 0 || pids.has(process.pid)) throw new Error(`BrainPet process soak sample ${index} has invalid or duplicate process identity.`);
      if (!process.role || !process.creationTime) throw new Error(`BrainPet process soak sample ${index} lacks process role or creation time.`);
      for (const key of ["totalWorkingSetBytes", "workingSetBytes", "privateBytes", "handleCount", "cpuTime100ns"] as const) {
        if (!Number.isFinite(process[key]) || process[key] < 0) throw new Error(`BrainPet process soak sample ${index} has invalid per-process ${key}.`);
      }
      if (process.workingSetBytes <= 0 || process.privateBytes <= 0 || process.handleCount <= 0) throw new Error(`BrainPet process soak sample ${index} has empty per-process resource evidence.`);
      pids.add(process.pid);
    }
    const root = sample.processes.find((process) => process.pid === sample.rootPid);
    if (!root || root.role !== "browser") throw new Error(`BrainPet process soak sample ${index} lacks the expected Electron browser root.`);
    if (!sample.processes.some((process) => process.role === "renderer")) throw new Error(`BrainPet process soak sample ${index} lacks an Electron renderer.`);
    for (const process of sample.processes) {
      if (process.pid === sample.rootPid) continue;
      const ancestors = new Set<number>([process.pid]);
      let current = process;
      while (current.pid !== sample.rootPid) {
        const parent = sample.processes.find((candidate) => candidate.pid === current.parentPid);
        if (!parent || ancestors.has(parent.pid)) throw new Error(`BrainPet process soak sample ${index} contains a process outside the root tree or a parent cycle.`);
        ancestors.add(parent.pid);
        current = parent;
      }
    }
    const sum = (key: "totalWorkingSetBytes" | "workingSetBytes" | "privateBytes" | "handleCount" | "cpuTime100ns") => sample.processes.reduce((total, process) => total + process[key], 0);
    if (sum("totalWorkingSetBytes") !== sample.totalWorkingSetBytes || sum("workingSetBytes") !== sample.workingSetBytes || sum("privateBytes") !== sample.privateBytes || sum("handleCount") !== sample.handleCount || sum("cpuTime100ns") !== sample.cpuTime100ns) throw new Error(`BrainPet process soak sample ${index} aggregate does not match its process details.`);
    const identity = [...sample.processes].sort((left, right) => left.pid - right.pid).map((process) => `${process.pid}@${process.creationTime}`).join(",");
    if (index === 0) expectedIdentity = identity;
    else if (identity !== expectedIdentity) throw new Error(`BrainPet process tree identity changed during the soak at sample ${index} (${sample.elapsedMs.toFixed(1)} ms): expected ${expectedIdentity}; received ${identity}.`);
    if (index > 0 && sample.elapsedMs <= samples[index - 1].elapsedMs) throw new Error("BrainPet process soak samples must have strictly increasing elapsed times.");
    if (index > 0 && sample.cpuTime100ns < samples[index - 1].cpuTime100ns) throw new Error("BrainPet process soak CPU time must not move backwards or reset during the run.");
  }
  const first = samples[0];
  const last = samples.at(-1)!;
  const durationMs = last.elapsedMs - first.elapsedMs;
  const cpuTimeDelta100ns = last.cpuTime100ns - first.cpuTime100ns;
  const intervals = samples.slice(1).map((sample, index) => {
    const previous = samples[index];
    const intervalMs = sample.elapsedMs - previous.elapsedMs;
    const intervalCpuTime100ns = sample.cpuTime100ns - previous.cpuTime100ns;
    return { intervalMs, cpuPercent: (intervalCpuTime100ns / (intervalMs * 10_000 * logicalProcessorCount)) * 100 };
  });
  const maximumHandleCount = Math.max(...samples.map((sample) => sample.handleCount));
  return {
    logicalProcessorCount,
    samples: samples.length,
    durationMs,
    maximumSampleIntervalMs: Math.max(...intervals.map((interval) => interval.intervalMs)),
    firstWorkingSetBytes: first.workingSetBytes,
    lastWorkingSetBytes: last.workingSetBytes,
    maximumWorkingSetBytes: Math.max(...samples.map((sample) => sample.workingSetBytes)),
    maximumTotalWorkingSetBytes: Math.max(...samples.map((sample) => sample.totalWorkingSetBytes)),
    workingSetGrowthBytes: last.workingSetBytes - first.workingSetBytes,
    maximumPrivateBytes: Math.max(...samples.map((sample) => sample.privateBytes)),
    maximumProcessCount: Math.max(...samples.map((sample) => sample.processCount)),
    firstHandleCount: first.handleCount,
    lastHandleCount: last.handleCount,
    maximumHandleCount,
    handleGrowth: last.handleCount - first.handleCount,
    maximumHandleGrowth: Math.max(0, maximumHandleCount - first.handleCount),
    averageCpuPercent: durationMs === 0 ? 0 : (cpuTimeDelta100ns / (durationMs * 10_000 * logicalProcessorCount)) * 100,
    maximumIntervalCpuPercent: Math.max(...intervals.map((interval) => interval.cpuPercent)),
    processIdentity: expectedIdentity,
    timeline: samples,
  };
}

export function evaluateBrainPetProcessSoakBudget(summary: BrainPetProcessSoakSummary, budget: BrainPetProcessSoakBudget): string[] {
  const violations: string[] = [];
  if (summary.samples < budget.minimumSamples) violations.push(`sample count ${summary.samples} is below ${budget.minimumSamples}`);
  if (summary.durationMs < budget.minimumDurationMs) violations.push(`duration ${summary.durationMs} is below ${budget.minimumDurationMs}`);
  if (summary.maximumSampleIntervalMs > budget.maximumSampleIntervalMs) violations.push(`sample interval ${summary.maximumSampleIntervalMs} exceeds ${budget.maximumSampleIntervalMs}`);
  if (summary.maximumProcessCount > budget.maximumProcessCount) violations.push(`process count ${summary.maximumProcessCount} exceeds ${budget.maximumProcessCount}`);
  if (summary.maximumTotalWorkingSetBytes > budget.maximumTotalWorkingSetBytes) violations.push(`total working set ${summary.maximumTotalWorkingSetBytes} exceeds ${budget.maximumTotalWorkingSetBytes}`);
  if (summary.maximumWorkingSetBytes > budget.maximumWorkingSetBytes) violations.push(`working set ${summary.maximumWorkingSetBytes} exceeds ${budget.maximumWorkingSetBytes}`);
  if (summary.maximumPrivateBytes > budget.maximumPrivateBytes) violations.push(`private bytes ${summary.maximumPrivateBytes} exceeds ${budget.maximumPrivateBytes}`);
  if (summary.workingSetGrowthBytes >= budget.maximumWorkingSetGrowthBytes) violations.push(`working set growth ${summary.workingSetGrowthBytes} is not below ${budget.maximumWorkingSetGrowthBytes}`);
  if (summary.maximumHandleCount > budget.maximumHandleCount) violations.push(`handle count ${summary.maximumHandleCount} exceeds ${budget.maximumHandleCount}`);
  if (summary.maximumHandleGrowth >= budget.maximumHandleGrowth) violations.push(`peak handle growth ${summary.maximumHandleGrowth} is not below ${budget.maximumHandleGrowth}`);
  if (budget.maximumIntervalCpuPercent !== undefined && summary.maximumIntervalCpuPercent >= budget.maximumIntervalCpuPercent) violations.push(`maximum interval CPU ${summary.maximumIntervalCpuPercent.toFixed(3)}% is not below ${budget.maximumIntervalCpuPercent}%`);
  return violations;
}

export function summarizeBrainPetResponsiveness(evidence: BrainPetResponsivenessEvidence): BrainPetResponsivenessSummary {
  return {
    coldStartup: summarizePercentiles("cold startup", evidence.coldStartupMs),
    hotFeedback: summarizePercentiles("hot feedback", evidence.hotFeedbackMs),
    coldWake: summarizePercentiles("cold wake", evidence.coldWakeMs),
    warmStageOpening: summarizePercentiles("warm stage opening", evidence.warmStageOpeningMs),
    rendererClose: summarizePercentiles("renderer close", evidence.rendererCloseMs),
    interactionFrameRate: summarizePercentiles("interaction frame rate", evidence.interactionFrameRateFps),
  };
}

export function evaluateBrainPetResponsivenessBudget(summary: BrainPetResponsivenessSummary, budget: BrainPetResponsivenessBudget): string[] {
  const violations: string[] = [];
  for (const [name, evidence] of Object.entries(summary)) {
    if (evidence.samples < budget.minimumSamples) violations.push(`${name} sample count ${evidence.samples} is below ${budget.minimumSamples}`);
  }
  if (summary.coldStartup.p95 > budget.maximumColdStartupP95Ms) violations.push(`cold startup p95 ${summary.coldStartup.p95}ms exceeds ${budget.maximumColdStartupP95Ms}ms`);
  if (summary.hotFeedback.p95 > budget.maximumHotFeedbackP95Ms) violations.push(`hot feedback p95 ${summary.hotFeedback.p95}ms exceeds ${budget.maximumHotFeedbackP95Ms}ms`);
  if (summary.coldWake.p95 > budget.maximumColdWakeP95Ms) violations.push(`cold wake p95 ${summary.coldWake.p95}ms exceeds ${budget.maximumColdWakeP95Ms}ms`);
  if (summary.warmStageOpening.p95 > budget.maximumWarmStageOpeningP95Ms) violations.push(`warm stage opening p95 ${summary.warmStageOpening.p95}ms exceeds ${budget.maximumWarmStageOpeningP95Ms}ms`);
  if (summary.rendererClose.maximum > budget.maximumRendererCloseMs) violations.push(`renderer close maximum ${summary.rendererClose.maximum}ms exceeds ${budget.maximumRendererCloseMs}ms`);
  if (summary.interactionFrameRate.p95 < budget.minimumInteractionFrameRateP95Fps) violations.push(`interaction frame rate p95 ${summary.interactionFrameRate.p95}fps is below ${budget.minimumInteractionFrameRateP95Fps}fps`);
  if (summary.interactionFrameRate.minimum < budget.minimumInteractionFrameRateFps) violations.push(`interaction frame rate minimum ${summary.interactionFrameRate.minimum}fps is below ${budget.minimumInteractionFrameRateFps}fps`);
  return violations;
}

function summarizePercentiles(name: string, samples: readonly number[]): BrainPetPercentileSummary {
  if (samples.length === 0) throw new Error(`BrainPet ${name} evidence requires at least one sample.`);
  const timeline = samples.map((sample, index) => {
    if (!Number.isFinite(sample) || sample < 0) throw new Error(`BrainPet ${name} sample ${index} is invalid.`);
    return sample;
  });
  const sorted = [...timeline].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    minimum: sorted[0],
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    maximum: sorted.at(-1)!,
    timeline,
  };
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}
