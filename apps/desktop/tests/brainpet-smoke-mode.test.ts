import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { advanceBrainPetIdleSettlement, BRAINPET_ACTIVE_SOAK_GATE_MS, BRAINPET_IDLE_SOAK_GATE_MS, resolveBrainPetSmokeMode, retryBrainPetHeapSample } from "../src/brainpet/smoke-mode.js";

const base = { activeSoakMs: 0, idleSoakMs: 0, expectDisabled: false, verifyOpenPetsIsolation: false, platform: "win32" as const };

test("canonical performance profiles require exact duration and remain machine-distinguishable from probes", () => {
  assert.deepEqual(resolveBrainPetSmokeMode({ ...base, activeSoakMs: BRAINPET_ACTIVE_SOAK_GATE_MS, gateProfile: "active-30m" }), { performanceKind: "active", gateProfile: "active-30m", gatePassedEligible: true });
  assert.deepEqual(resolveBrainPetSmokeMode({ ...base, idleSoakMs: BRAINPET_IDLE_SOAK_GATE_MS, gateProfile: "idle-24h" }), { performanceKind: "idle", gateProfile: "idle-24h", gatePassedEligible: true });
  assert.deepEqual(resolveBrainPetSmokeMode({ ...base, activeSoakMs: 60_000 }), { performanceKind: "active", gateProfile: "probe", gatePassedEligible: false });
  assert.throws(() => resolveBrainPetSmokeMode({ ...base, activeSoakMs: 60_000, gateProfile: "active-30m" }), /exactly 30 minutes/i);
  assert.throws(() => resolveBrainPetSmokeMode({ ...base, idleSoakMs: 60_000, gateProfile: "idle-24h" }), /exactly 24 hours/i);
});

test("performance modes reject rollback, OpenPets isolation, mixed modes and unsupported platforms before launch", () => {
  assert.throws(() => resolveBrainPetSmokeMode({ ...base, activeSoakMs: 60_000, expectDisabled: true }), /rollback/i);
  assert.throws(() => resolveBrainPetSmokeMode({ ...base, activeSoakMs: 60_000, verifyOpenPetsIsolation: true }), /OpenPets isolation/i);
  assert.throws(() => resolveBrainPetSmokeMode({ ...base, idleSoakMs: 60_000, expectDisabled: true }), /rollback/i);
  assert.throws(() => resolveBrainPetSmokeMode({ ...base, activeSoakMs: 1, idleSoakMs: 1 }), /mutually exclusive/i);
  assert.throws(() => resolveBrainPetSmokeMode({ ...base, activeSoakMs: BRAINPET_ACTIVE_SOAK_GATE_MS, gateProfile: "active-30m", platform: "darwin" }), /requires Windows/i);
});

test("heap sampling retries only bounded transient CDP transport failures", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await retryBrainPetHeapSample(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("CDP socket failed: Runtime.getHeapUsage");
      return { usedSize: 42 };
    },
    async (delayMs) => { waits.push(delayMs); },
  );
  assert.deepEqual(result, { usedSize: 42 });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [100, 100]);

  let permanentAttempts = 0;
  await assert.rejects(
    retryBrainPetHeapSample(async () => {
      permanentAttempts += 1;
      throw new Error("Runtime.getHeapUsage: target crashed");
    }),
    /target crashed/,
  );
  assert.equal(permanentAttempts, 1);

  let exhaustedAttempts = 0;
  await assert.rejects(
    retryBrainPetHeapSample(
      async () => {
        exhaustedAttempts += 1;
        throw new Error("CDP command timed out: Runtime.getHeapUsage");
      },
      async () => undefined,
    ),
    /command timed out/,
  );
  assert.equal(exhaustedAttempts, 3);
});

test("idle settlement starts only after the replacement target and exact process identity stay stable", () => {
  const browser = { pid: 10, creationTime: "browser-start", role: "browser" };
  const oldRenderer = { pid: 11, creationTime: "old-start", role: "renderer" };
  const newRenderer = { pid: 12, creationTime: "new-start", role: "renderer" };
  let state = advanceBrainPetIdleSettlement(null, { observedAtMs: 0, targetIds: ["old"], processes: [browser, oldRenderer] });
  assert.equal(state.settled, false);
  state = advanceBrainPetIdleSettlement(state.state, { observedAtMs: 1_000, targetIds: ["old", "new"], processes: [browser, oldRenderer, newRenderer] });
  assert.deepEqual(state, { state: null, settled: false });
  state = advanceBrainPetIdleSettlement(state.state, { observedAtMs: 1_250, targetIds: ["new"], processes: [browser, newRenderer] });
  assert.equal(state.settled, false);
  state = advanceBrainPetIdleSettlement(state.state, { observedAtMs: 3_249, targetIds: ["new"], processes: [browser, newRenderer] });
  assert.equal(state.settled, false);
  state = advanceBrainPetIdleSettlement(state.state, { observedAtMs: 3_250, targetIds: ["new"], processes: [browser, newRenderer] });
  assert.equal(state.settled, true);

  const churned = advanceBrainPetIdleSettlement(state.state, {
    observedAtMs: 4_000,
    targetIds: ["new"],
    processes: [browser, { ...newRenderer, pid: 13 }],
  });
  assert.equal(churned.settled, false);
  assert.equal(churned.state?.stableSinceMs, 4_000);
});

test("canonical package commands and the Windows collector stay bound to the fail-closed contract", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["test:brainpet-soak"], "pnpm brainpet:active-gate:start");
  assert.equal(packageJson.scripts["test:brainpet-idle-soak"], "pnpm brainpet:idle-gate:start");
  assert.equal(packageJson.scripts["package:brainpet:unpacked"], "node scripts/brainpet-package.mjs --target dir --mode private-test");
  const smokeSource = await readFile(new URL("../../scripts/brainpet-electron-smoke.mjs", import.meta.url), "utf8");
  assert.match(smokeSource, /BRAINPET_METRICS_ROOT_PID/);
  assert.match(smokeSource, /Win32_PerfRawData_PerfProc_Process[\s\S]*WorkingSetPrivate/);
  assert.match(smokeSource, /private working-set counters are missing/);
  assert.match(smokeSource, /for \(\$attempt = 1; \$attempt -le 3; \$attempt \+= 1\)[\s\S]*Start-Sleep -Milliseconds 100[\s\S]*if \(\$missingPrivateWorkingSet\.Count -gt 0\) \{ throw/);
  assert.match(smokeSource, /\$expectedIdentity = \$identity[\s\S]*process tree changed during private working-set retry/);
  assert.match(smokeSource, /if \(\$ids\.Contains\(\[uint32\]\$process\.ParentProcessId\) -and \$ids\.Add/);
  assert.doesNotMatch(smokeSource, /rootNames\.Contains/);
  assert.match(smokeSource, /gatePassed: smokeMode\.gatePassedEligible/);
  assert.match(smokeSource, /smokeMode\.performanceKind !== "none" \? "0"[\s\S]*OPENPETS_LOG_CONSOLE: smokeConsoleLogging/);
  assert.match(smokeSource, /runColdPerformancePreflight\(40\)/);
  assert.match(smokeSource, /waitForColdIdleSettlement\(port, petWindowTitle, electronRootPid, userDataDir, 30_000\)[\s\S]*petTarget = settledIdle\.target/);
  assert.match(smokeSource, /retryBrainPetHeapSample\(\(\) => sendCdp\(target\.webSocketDebuggerUrl, "Runtime\.getHeapUsage", \{\}, 5_000\)\)/);
  assert.match(smokeSource, /await delay\(10_000\)/);
  assert.match(smokeSource, /cleanup become quiescent[\s\S]*await delay\(2_000\)/);
  assert.match(smokeSource, /spawnSync\(stagedHelper, \["--agent", "codex"\][\s\S]*hook_event_name: "UserPromptSubmit"/);
  assert.match(smokeSource, /data-session="\$\{wakeSessionId\}"\]\[data-turn="\$\{wakeTurnId\}"\]/);
  assert.match(smokeSource, /listProcessIdentitiesForExactRootPid\(wakeDiscovery\.pid, stagedExecutable, wakeStartedEpochMs\)/);
  assert.match(smokeSource, /stopProcessesForUserDataDir\(join\(wakeRoaming, "BrainPet"\), wakeIdentities, stagedExecutable\)/);
  assert.match(smokeSource, /coldWakeMs\.push\(performance\.now\(\) - wakeStartedAt\)/);
  assert.match(smokeSource, /maximumTotalWorkingSetBytes/);
  assert.match(smokeSource, /minimumInteractionFrameRateP95Fps: 50/);
  assert.match(smokeSource, /maximumHandleCount: 2_750/);
  assert.match(smokeSource, /handleCount: 2_750/);
  assert.match(smokeSource, /\/json\/list`[\s\S]*AbortSignal\.timeout\(1_000\)/);
  assert.match(smokeSource, /waitForTargetToDisappear[\s\S]*catch \{[\s\S]*endpoint never becomes observable again/);
  assert.match(smokeSource, /validateBrainPetPerformanceCandidate[\s\S]*runColdPerformancePreflight\(40\)/);
  assert.doesNotMatch(smokeSource, /writeBrainPetPerformanceReceipt/);
  assert.match(smokeSource, /Timed out after \$\{timeoutMs\} ms waiting for process/);
  assert.match(smokeSource, /Formal responsiveness and soak evidence must execute the same packaged BrainPet bytes/);
  const receiptSource = await readFile(new URL("../../scripts/brainpet-performance-receipt.mjs", import.meta.url), "utf8");
  assert.match(receiptSource, /status", "--porcelain=v1", "--untracked-files=no"/);
  assert.match(receiptSource, /packageReceipt\.source\.treeDirty, false/);
  assert.match(receiptSource, /appAsarSha256[\s\S]*packaged app\.asar bytes do not match/);
  assert.match(receiptSource, /await handle\.sync\(\)[\s\S]*await link\(temporary, target\)/);
  assert.doesNotMatch(receiptSource, /rename\(temporary, target\)/);
  assert.match(receiptSource, /let published = false[\s\S]*removePublishedReceipt\(receiptPath\)[\s\S]*BrainPetPerformanceReceiptRollbackError/);
  const runnerSource = await readFile(new URL("../../scripts/brainpet-performance-gate-runner.mjs", import.meta.url), "utf8");
  assert.match(runnerSource, /detached: true/);
  assert.match(runnerSource, /windowsHide: true/);
  assert.match(runnerSource, /identity\.creationDate === expected\.creationDate/);
  assert.match(runnerSource, /normalizeWindowsPath\(identity\.executablePath\) === normalizeWindowsPath\(expected\.executable\)/);
  assert.match(runnerSource, /commandNeedles\.every/);
  assert.match(runnerSource, /waitForPath\(manifestPath, 30_000\)[\s\S]*runPnpmDesktopScript/);
  assert.match(runnerSource, /createCleanPerformanceEnvironment[\s\S]*BRAINPET_ENFORCE_RESOURCE_BUDGET: "1"/);
  assert.match(runnerSource, /validateBrainPetPerformanceReceipt[\s\S]*finalizePerformancePublication\(\{/);
  assert.match(runnerSource, /status\.state === "interrupted" && status\.receiptPath[\s\S]*rmSyncExact/);
  assert.match(runnerSource, /finalizePerformancePublication[\s\S]*removePublishedBrainPetPerformanceReceipt[\s\S]*preserving the recovery lease/);
  assert.match(runnerSource, /caught instanceof BrainPetPerformanceReceiptRollbackError[\s\S]*throw caught/);
  assert.match(runnerSource, /brainpet-windows-job-supervisor\.ps1[\s\S]*child-supervisor-ready[\s\S]*brainpet-windows-job-resume-permit[\s\S]*jobQuiescent/);
  assert.doesNotMatch(runnerSource, /child-completed|runWrappedChild|sendWrapperMessage/);
  const brainPetBuilder = await readFile(new URL("../../electron-builder.brainpet.base.yml", import.meta.url), "utf8");
  assert.doesNotMatch(brainPetBuilder, /asarUnpack:[\s\S]*node_modules\/\*\*/);
  const hostCore = await readFile(new URL("../../src/composition/host-core.ts", import.meta.url), "utf8");
  assert.match(hostCore, /setImmediate\(startVisibleUi\)/);
  assert.match(hostCore, /showDefaultPet\(\)[\s\S]*webContents\.once\("did-finish-load", scheduleTrayAfterPetReady\)/);
  assert.match(hostCore, /scheduleTrayAfterPetReady[\s\S]*setTimeout\(startTrayAndUpdate, 2_000\)/);
  assert.match(hostCore, /updateCheckTimer = setTimeout[\s\S]*checkForGitHubReleaseUpdate[\s\S]*60_000/);
  assert.doesNotMatch(hostCore, /^import \{ checkForGitHubReleaseUpdate \}/m);
});
