import assert from "node:assert/strict";

export function normalizeBrainPetInstantProcessMetrics(metrics, label, budget) {
  assert.ok(isRecord(metrics), `BrainPet ${label} process metrics are missing.`);
  assert.ok(Number.isInteger(metrics.rootPid) && metrics.rootPid > 0, `BrainPet ${label} root PID is invalid.`);
  assert.ok(Number.isInteger(metrics.processCount) && metrics.processCount > 0, `BrainPet ${label} process count is invalid.`);
  assert.ok(Array.isArray(metrics.processes) && metrics.processes.length === metrics.processCount, `BrainPet ${label} process detail count is invalid.`);

  const processes = metrics.processes.map((process, index) => normalizeProcess(process, label, index));
  const ordered = [...processes].sort((left, right) => left.pid - right.pid);
  assert.deepEqual(processes, ordered, `BrainPet ${label} process details are not in canonical PID order.`);
  const byPid = new Map();
  for (const process of processes) {
    assert.equal(byPid.has(process.pid), false, `BrainPet ${label} contains a duplicate process PID.`);
    byPid.set(process.pid, process);
  }
  const root = byPid.get(metrics.rootPid);
  assert.equal(root?.role, "browser", `BrainPet ${label} lacks the Electron browser root.`);
  assert.ok(processes.some((process) => process.role === "renderer"), `BrainPet ${label} lacks an Electron renderer.`);
  for (const process of processes) {
    if (process.pid === metrics.rootPid) continue;
    const seen = new Set([process.pid]);
    let current = process;
    while (current.pid !== metrics.rootPid) {
      const parent = byPid.get(current.parentPid);
      assert.ok(parent && !seen.has(parent.pid), `BrainPet ${label} contains an unrelated process or parent cycle.`);
      seen.add(parent.pid);
      current = parent;
    }
  }

  const aggregateKeys = ["totalWorkingSetBytes", "workingSetBytes", "privateBytes", "handleCount", "cpuTime100ns"];
  for (const key of aggregateKeys) {
    const expected = processes.reduce((total, process) => total + process[key], 0);
    assert.equal(metrics[key], expected, `BrainPet ${label} ${key} does not match its process details.`);
  }
  assert.ok(metrics.processCount <= budget.maximumProcessCount, `BrainPet ${label} process count exceeds ${budget.maximumProcessCount}.`);
  assert.ok(metrics.totalWorkingSetBytes <= budget.maximumTotalWorkingSetBytes, `BrainPet ${label} total working set exceeds ${budget.maximumTotalWorkingSetBytes}.`);
  assert.ok(metrics.workingSetBytes <= budget.maximumWorkingSetBytes, `BrainPet ${label} working set exceeds ${budget.maximumWorkingSetBytes}.`);
  assert.ok(metrics.privateBytes <= budget.maximumPrivateBytes, `BrainPet ${label} private bytes exceed ${budget.maximumPrivateBytes}.`);
  assert.ok(metrics.handleCount <= budget.maximumHandleCount, `BrainPet ${label} handle count exceeds ${budget.maximumHandleCount}.`);

  const normalized = {
    rootPid: metrics.rootPid,
    processCount: metrics.processCount,
    totalWorkingSetBytes: metrics.totalWorkingSetBytes,
    workingSetBytes: metrics.workingSetBytes,
    privateBytes: metrics.privateBytes,
    handleCount: metrics.handleCount,
    cpuTime100ns: metrics.cpuTime100ns,
    processes,
  };
  assert.deepEqual(metrics, normalized, `BrainPet ${label} process metrics contain unexpected or non-canonical fields.`);
  return normalized;
}

export function assertBrainPetPerformanceWallClock(startedAt, completedAt, minimumDurationMs) {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  assert.ok(Number.isFinite(started) && Number.isFinite(completed) && completed - started >= minimumDurationMs, `BrainPet performance receipt wall-clock span is shorter than ${minimumDurationMs} ms.`);
}

function normalizeProcess(process, label, index) {
  assert.ok(isRecord(process), `BrainPet ${label} process ${index} is invalid.`);
  assert.ok(Number.isInteger(process.pid) && process.pid > 0, `BrainPet ${label} process ${index} PID is invalid.`);
  assert.ok(Number.isInteger(process.parentPid) && process.parentPid >= 0, `BrainPet ${label} process ${index} parent PID is invalid.`);
  assert.ok(typeof process.role === "string" && process.role.length > 0 && process.role.length <= 64, `BrainPet ${label} process ${index} role is invalid.`);
  assert.ok(typeof process.creationTime === "string" && Number.isFinite(Date.parse(process.creationTime)), `BrainPet ${label} process ${index} creation time is invalid.`);
  for (const key of ["totalWorkingSetBytes", "workingSetBytes", "privateBytes", "handleCount"]) {
    assert.ok(Number.isFinite(process[key]) && process[key] > 0, `BrainPet ${label} process ${index} ${key} is invalid.`);
  }
  assert.ok(Number.isFinite(process.cpuTime100ns) && process.cpuTime100ns >= 0, `BrainPet ${label} process ${index} CPU time is invalid.`);
  assert.deepEqual(Object.keys(process).sort(), ["cpuTime100ns", "creationTime", "handleCount", "parentPid", "pid", "privateBytes", "role", "totalWorkingSetBytes", "workingSetBytes"].sort(), `BrainPet ${label} process ${index} has unexpected fields.`);
  return {
    pid: process.pid,
    parentPid: process.parentPid,
    role: process.role,
    creationTime: process.creationTime,
    totalWorkingSetBytes: process.totalWorkingSetBytes,
    workingSetBytes: process.workingSetBytes,
    privateBytes: process.privateBytes,
    handleCount: process.handleCount,
    cpuTime100ns: process.cpuTime100ns,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
