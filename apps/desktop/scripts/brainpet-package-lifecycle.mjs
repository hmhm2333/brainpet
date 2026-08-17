#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { createServer } from "node:net";

import { brainPetDistributionContract, brainPetReleaseTargets } from "../../../scripts/brainpet-release-contract.mjs";
import { materializeLifecycleHelper, removeOwnedLifecycleDiscovery, stageLifecycleAppImageForExtraction } from "./brainpet-package-lifecycle-support.mjs";

const appDir = resolve(import.meta.dirname, "..");
const maxReceiptBytes = 2 * 1024 * 1024;
let debPackageIndexReady = false;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = brainPetReleaseTargets.find((candidate) => candidate.id === options.targetId);
  assert.ok(target, `Unknown lifecycle target: ${options.targetId}`);
  assert.equal(target.nodePlatform, process.platform, `Lifecycle test for ${target.id} must run on ${target.nodePlatform}.`);
  assert.equal(target.arch, process.arch, `Lifecycle test for ${target.id} must run on ${target.arch}.`);
  assert.equal(process.env.CI, "true", "Real installer lifecycle mutates the host and is restricted to disposable CI runners.");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Real installer lifecycle must run in trusted GitHub Actions.");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "Real installer lifecycle requires a GitHub-hosted clean runner.");
  for (const forbidden of ["OPENPETS_DISCOVERY_FILE", "BRAINPET_INSTALL_MARKER_FILE"]) assert.equal(process.env[forbidden], undefined, `${forbidden} would bypass default packaged discovery.`);

  const currentPackage = loadPackage(options.currentOutput, target.id, options.artifactKind);
  const previousPackage = loadPackage(options.previousOutput, target.id, options.artifactKind);
  assert.equal(compareVersions(previousPackage.receipt.appVersion, currentPackage.receipt.appVersion) < 0, true, "Upgrade fixture version must be older than the current package.");
  assert.equal(currentPackage.receipt.source.commit, process.env.GITHUB_SHA, "Lifecycle package must bind the checked-out CI commit.");
  const paths = resolveDefaultPaths(target, options.artifactKind);
  assert.equal(existsSync(paths.executable), false, `Clean runner already contains BrainPet at ${paths.executable}.`);
  assert.equal(existsSync(paths.marker), false, `Clean runner already contains a BrainPet install marker at ${paths.marker}.`);
  assert.equal(existsSync(paths.discovery), false, `Clean runner already contains BrainPet discovery at ${paths.discovery}.`);

  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ? resolve(process.env.RUNNER_TEMP) : tmpdir(), "brainpet-lifecycle-"));
  const installedMarketplace = paths.resources ? join(paths.resources, "integrations", "codex", "brainpet-marketplace") : null;
  const fixture = createCodexFixture(scratch, currentPackage.receipt.nativeBridgeHelperSha256, installedMarketplace);
  let previousHelper;
  let currentHelper;
  let installReceipt;
  let upgradeReceipt;
  let uninstallReceipt;
  const sentinelPath = join(paths.userData, "release-e2e-state-sentinel.json");
  const sentinelBytes = Buffer.from(`${JSON.stringify({ id: randomUUID(), createdBy: "brainpet-package-lifecycle" })}\n`);
  let coldWakeBefore = 0;
  let coldWakeAfter = 0;

  try {
    installArtifact(previousPackage.artifact.path, target, options.artifactKind, paths, scratch);
    assertRegularFile(paths.executable, "Installed BrainPet executable");
    previousHelper = materializePackagedHelper(previousPackage, target, options.artifactKind, paths, scratch, "previous");
    const first = await launchRuntime(paths.executable, paths, fixture, { openSetup: true, target, artifactKind: options.artifactKind });
    try {
      await connectAdapter(first.debugPort);
      const stateBefore = readInstallationState(paths.userData);
      runHelper(previousHelper, fixture.environment, "UserPromptSubmit", "install-lifecycle");
      const stateAfter = await waitForInstallationState(paths.userData, (state) => state.lifecycleVerifiedAt > (stateBefore.lifecycleVerifiedAt ?? 0), 10_000);
      assert.equal(stateAfter.lifecycleVerifiedBridgeVersion, brainPetDistributionContract.bridge.version);
      installReceipt = readAdapterReceipt(paths.userData, "install");
      mkdirSync(dirname(sentinelPath), { recursive: true });
      writeFileSync(sentinelPath, sentinelBytes, { flag: "wx", mode: 0o600 });
      coldWakeBefore = stateAfter.lifecycleVerifiedAt;
    } finally {
      await stopRuntime(first, paths.executable, paths.discovery);
    }

    runHelper(previousHelper, fixture.environment, "PreToolUse", "cold-wake");
    const coldDiscovery = await waitForJson(paths.discovery, (value) => value.product === "brainpet" && value.appId === brainPetDistributionContract.identity.appId, 10_000);
    const coldState = await waitForInstallationState(paths.userData, (state) => state.lifecycleVerifiedAt > coldWakeBefore, 10_000);
    coldWakeAfter = coldState.lifecycleVerifiedAt;
    await terminateDiscoveredRuntime(coldDiscovery, paths.executable);
    await cleanupTerminatedRuntimeDiscovery(paths.discovery, coldDiscovery);

    installArtifact(currentPackage.artifact.path, target, options.artifactKind, paths, scratch);
    currentHelper = materializePackagedHelper(currentPackage, target, options.artifactKind, paths, scratch, "current");
    assert.deepEqual(readFileSync(sentinelPath), sentinelBytes, "Upgrade removed user state.");
    setFixtureInstalledVersion(fixture.codexHome, "0.2.999");
    const upgraded = await launchRuntime(paths.executable, paths, fixture, { openSetup: true, target, artifactKind: options.artifactKind });
    try {
      const marker = await waitForJson(paths.marker, (value) => value.appVersion === currentPackage.receipt.appVersion, 10_000);
      assert.equal(marker.executablePath.toLowerCase(), paths.executable.toLowerCase(), "Upgrade marker does not reference the installed runtime.");
      await connectAdapter(upgraded.debugPort);
      upgradeReceipt = readAdapterReceipt(paths.userData, "upgrade");
      runHelper(currentHelper, fixture.environment, "PostToolUse", "upgraded-lifecycle");
      await disconnectAdapter(upgraded.debugPort);
      uninstallReceipt = readAdapterReceipt(paths.userData, "uninstall");
      assert.deepEqual(readFileSync(sentinelPath), sentinelBytes, "Starting the upgraded runtime changed the preservation sentinel.");
    } finally {
      await stopRuntime(upgraded, paths.executable, paths.discovery);
    }

    uninstallArtifact(currentPackage.artifact.path, target, options.artifactKind, paths);
    assert.equal(existsSync(paths.executable), false, "BrainPet executable remains after uninstall.");
    runHelper(currentHelper, fixture.environment, "UserPromptSubmit", "post-uninstall");
    await delay(3_000);
    assert.equal(existsSync(paths.discovery), false, "Packaged helper restarted BrainPet after uninstall.");
    assert.equal(existsSync(paths.marker), false, "Stale install marker remains after uninstall/helper recovery.");
    assert.equal(existsSync(`${paths.marker}.bak`), false, "Stale backup install marker remains after uninstall/helper recovery.");
    assert.deepEqual(readFileSync(sentinelPath), sentinelBytes, "Runtime uninstall removed user progress.");

    const receipt = {
      schemaVersion: 1,
      product: "brainpet",
      target: target.id,
      supportLevel: target.supportLevel,
      artifactKind: options.artifactKind,
      currentArtifact: summarizeArtifact(currentPackage),
      previousArtifact: summarizeArtifact(previousPackage),
      source: {
        repository: process.env.GITHUB_REPOSITORY,
        commit: process.env.GITHUB_SHA,
        workflow: process.env.GITHUB_WORKFLOW,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      },
      trustedCi: true,
      cleanRunner: true,
      realInstaller: true,
      defaultInstallPath: true,
      defaultDiscovery: true,
      packagedHelper: true,
      toolchainIsolatedHelper: true,
      install: { passed: true, executable: paths.executable, marker: paths.marker },
      start: { passed: true, discovery: paths.discovery },
      adapter: {
        install: installReceipt.status === "succeeded",
        installReceiptSha256: hashBytes(Buffer.from(JSON.stringify(installReceipt))),
        upgrade: upgradeReceipt.status === "succeeded",
        upgradeReceiptSha256: hashBytes(Buffer.from(JSON.stringify(upgradeReceipt))),
        uninstall: uninstallReceipt.status === "succeeded",
        uninstallReceiptSha256: hashBytes(Buffer.from(JSON.stringify(uninstallReceipt))),
      },
      coldWake: { passed: coldWakeAfter > coldWakeBefore, before: coldWakeBefore, after: coldWakeAfter },
      upgrade: { passed: true, fromVersion: previousPackage.receipt.appVersion, toVersion: currentPackage.receipt.appVersion, statePreserved: true },
      uninstall: { passed: true, userStatePreserved: true, helperFailOpen: true, markerRemoved: true },
      overallStatus: "passed",
      completedAt: new Date().toISOString(),
    };
    const outputPath = resolve(options.receiptPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`BrainPet real installer lifecycle passed (${target.id}/${options.artifactKind}).`);
  } finally {
    await terminateInstalledRuntime(paths.executable).catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") options.targetId = argv[++index];
    else if (arg === "--artifact-kind") options.artifactKind = argv[++index];
    else if (arg === "--current-output") options.currentOutput = argv[++index];
    else if (arg === "--previous-output") options.previousOutput = argv[++index];
    else if (arg === "--receipt") options.receiptPath = argv[++index];
    else throw new Error(`Unknown lifecycle argument: ${arg}`);
  }
  if (!options.targetId || !options.artifactKind || !options.currentOutput || !options.previousOutput || !options.receiptPath) throw new Error("Usage: brainpet-package-lifecycle.mjs --target <id> --artifact-kind <nsis|dmg|appimage|deb> --current-output <dir> --previous-output <dir> --receipt <path>");
  assert.ok(["nsis", "dmg", "appimage", "deb"].includes(options.artifactKind), "Unsupported lifecycle artifact kind.");
  return options;
}

function loadPackage(outputRoot, targetId, artifactKind) {
  const root = resolve(outputRoot);
  const receiptPath = join(root, `brainpet-package-receipt-${targetId}.json`);
  const receipt = readJson(receiptPath);
  assert.equal(receipt.target, targetId);
  assert.equal(receipt.packageTarget, "installer");
  const record = receipt.artifacts.find((candidate) => candidate.kind === artifactKind);
  assert.ok(record, `Package ${targetId} has no ${artifactKind} artifact.`);
  const artifactPath = resolve(root, record.path);
  assert.ok(artifactPath.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`), "Package artifact escaped its output root.");
  assertRegularFile(artifactPath, "Package artifact");
  assert.equal(lstatSync(artifactPath).size, record.bytes);
  assert.equal(hashFile(artifactPath), record.sha256);
  return { root, receiptPath, receipt, artifact: { ...record, path: artifactPath } };
}

function resolveDefaultPaths(target, artifactKind) {
  if (target.platform === "windows") {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    assert.ok(appData && localAppData, "Windows lifecycle requires APPDATA and LOCALAPPDATA.");
    return {
      userData: join(appData, "BrainPet"),
      marker: join(localAppData, "BrainPet", "runtime-install.json"),
      discovery: join(appData, "BrainPet", "runtime", "ipc.json"),
      executable: join(localAppData, "Programs", "brainpet", "brainpet.exe"),
      resources: join(localAppData, "Programs", "brainpet", "resources"),
    };
  }
  if (target.platform === "macos") {
    const userData = join(homedir(), "Library", "Application Support", "BrainPet");
    return {
      userData,
      marker: join(userData, "runtime-install.json"),
      discovery: join(userData, "runtime", "ipc.json"),
      executable: "/Applications/BrainPet.app/Contents/MacOS/brainpet",
      resources: "/Applications/BrainPet.app/Contents/Resources",
    };
  }
  const configHome = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(homedir(), ".config");
  const runtimeHome = process.env.XDG_RUNTIME_DIR ? resolve(process.env.XDG_RUNTIME_DIR) : configHome;
  const userData = join(configHome, "BrainPet");
  const executable = artifactKind === "appimage" ? join(homedir(), "Applications", "BrainPet.AppImage") : "/opt/BrainPet/brainpet";
  return {
    userData,
    marker: join(configHome, "BrainPet", "runtime-install.json"),
    discovery: process.env.XDG_RUNTIME_DIR ? join(runtimeHome, "brainpet", "ipc.json") : join(configHome, "BrainPet", "runtime", "ipc.json"),
    executable,
    resources: artifactKind === "deb" ? "/opt/BrainPet/resources" : null,
  };
}

function installArtifact(path, target, kind, paths, scratch) {
  if (target.platform === "windows") {
    runRequired(path, ["/S"], { timeout: 120_000 });
    assertRegularFile(paths.executable, "NSIS-installed BrainPet executable");
    return;
  }
  if (target.platform === "macos") {
    const mount = join(scratch, `dmg-${randomUUID()}`);
    mkdirSync(mount, { recursive: true });
    runRequired("hdiutil", ["attach", path, "-nobrowse", "-readonly", "-mountpoint", mount], { timeout: 120_000 });
    try {
      if (existsSync("/Applications/BrainPet.app")) runRequired("sudo", ["rm", "-rf", "/Applications/BrainPet.app"], { timeout: 30_000 });
      runRequired("sudo", ["ditto", join(mount, "BrainPet.app"), "/Applications/BrainPet.app"], { timeout: 120_000 });
    } finally {
      runRequired("hdiutil", ["detach", mount, "-force"], { timeout: 30_000 });
    }
    return;
  }
  if (kind === "appimage") {
    mkdirSync(dirname(paths.executable), { recursive: true });
    copyFileSync(path, paths.executable);
    chmodSync(paths.executable, 0o755);
    return;
  }
  if (!debPackageIndexReady) {
    runRequired("sudo", ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "update"], { timeout: 120_000 });
    debPackageIndexReady = true;
  }
  runRequired("sudo", ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "--yes", "--no-install-recommends", path], { timeout: 180_000 });
}

function uninstallArtifact(path, target, kind, paths) {
  if (target.platform === "windows") {
    const uninstallers = findFiles(dirname(paths.executable), (name) => /^Uninstall.*\.exe$/i.test(name));
    assert.equal(uninstallers.length, 1, "NSIS uninstall executable was not found.");
    runRequired(uninstallers[0], ["/S"], { timeout: 120_000 });
    return;
  }
  if (target.platform === "macos") {
    runRequired("sudo", ["rm", "-rf", "/Applications/BrainPet.app"], { timeout: 30_000 });
    return;
  }
  if (kind === "appimage") {
    rmSync(paths.executable);
    return;
  }
  const packageName = runRequired("dpkg-deb", ["-f", path, "Package"]).stdout.trim();
  assert.match(packageName, /^[a-z0-9][a-z0-9+.-]{1,80}$/);
  runRequired("sudo", ["dpkg", "-r", packageName], { timeout: 120_000 });
}

function materializePackagedHelper(packageInfo, target, kind, paths, scratch, label) {
  let helperSource;
  if (kind === "appimage") {
    const staged = stageLifecycleAppImageForExtraction(packageInfo.artifact.path, scratch, label);
    runRequired(staged.stagedArtifact, ["--appimage-extract"], { cwd: staged.extractRoot, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" }, timeout: 120_000 });
    helperSource = join(staged.extractRoot, "squashfs-root", "resources", "integrations", "codex", "brainpet-marketplace", "plugins", "brainpet-codex-bridge", "bin", target.id, target.helperName);
  } else {
    helperSource = join(paths.resources, "integrations", "codex", "brainpet-marketplace", "plugins", "brainpet-codex-bridge", "bin", target.id, target.helperName);
  }
  return materializeLifecycleHelper(helperSource, scratch, label, target.helperName, packageInfo.receipt.nativeBridgeHelperSha256);
}

async function launchRuntime(executable, paths, fixture, options) {
  const debugPort = await reservePort();
  const args = [`--remote-debugging-port=${debugPort}`];
  if (options.openSetup) args.push("--brainpet-open-setup-guide");
  const environment = { ...process.env, ...fixture.environment, OPENPETS_DISABLE_PLUGIN_CATALOG: "1", OPENPETS_LOG_CONSOLE: "1" };
  if (options.artifactKind === "appimage") environment.APPIMAGE_EXTRACT_AND_RUN = "1";
  let command = executable;
  let commandArgs = args;
  if (options.target.platform === "linux") {
    commandArgs = [...args, "--no-sandbox"];
    if (!environment.DISPLAY) {
      command = "xvfb-run";
      commandArgs = ["-a", executable, ...commandArgs];
    }
  }
  const logs = [];
  const child = spawn(command, commandArgs, { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));
  try {
    const discovery = await waitForJson(paths.discovery, (value) => value.product === "brainpet" && value.appId === brainPetDistributionContract.identity.appId, 20_000);
    if (options.openSetup) await waitForTarget(debugPort, (target) => target.url.includes("brainpet-setup.html"), 20_000);
    return { child, debugPort, logs, discovery };
  } catch (error) {
    await terminateInstalledRuntime(executable).catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.join("")}`);
  }
}

async function stopRuntime(runtime, executable, discovery) {
  let exited = false;
  try {
    await requestRuntimeQuit(runtime.debugPort);
    exited = await waitForExit(runtime.child, 10_000);
  } catch {
    // Browser.close is a best-effort graceful path; exact process and discovery
    // ownership checks below keep the fallback fail closed.
  }
  if (!exited) {
    runtime.child.kill();
    await waitForExit(runtime.child, 5_000);
  }
  await terminateDiscoveredRuntime(runtime.discovery, executable);
  await cleanupTerminatedRuntimeDiscovery(discovery, runtime.discovery);
}

async function requestRuntimeQuit(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2_000) });
  assert.equal(response.ok, true, "Packaged BrainPet browser endpoint rejected the graceful quit request.");
  const version = await response.json();
  assert.equal(typeof version.webSocketDebuggerUrl, "string", "Packaged BrainPet did not expose its browser CDP endpoint.");
  await sendCdp(version.webSocketDebuggerUrl, "Browser.close", {});
}

async function cleanupTerminatedRuntimeDiscovery(path, expected) {
  assert.equal(isProcessAlive(expected.pid), false, `BrainPet discovery PID ${expected.pid} is still alive during cleanup.`);
  try {
    await waitForMissing(path, 2_000);
    return;
  } catch {
    removeOwnedLifecycleDiscovery(path, expected);
  }
  await waitForMissing(path, 2_000);
}

async function connectAdapter(debugPort) {
  const target = await waitForTarget(debugPort, (candidate) => candidate.url.includes("brainpet-setup.html"), 10_000);
  await waitForEvaluation(target, `['CONNECT','UPGRADE','连接','升级'].some(value => document.getElementById('bridge-status')?.textContent?.includes(value))`, 10_000);
  await evaluate(target, `document.getElementById('bridge-status').click()`);
  await waitForEvaluation(target, `document.getElementById('bridge-status')?.textContent?.includes('CONNECTED') || document.getElementById('bridge-status')?.textContent?.includes('已连接')`, 20_000);
}

async function disconnectAdapter(debugPort) {
  const target = await waitForTarget(debugPort, (candidate) => candidate.url.includes("brainpet-setup.html"), 10_000);
  await waitForEvaluation(target, `!document.getElementById('disconnect')?.classList.contains('hidden')`, 10_000);
  await evaluate(target, `document.getElementById('disconnect').click()`);
  await waitForEvaluation(target, `document.getElementById('disconnect')?.classList.contains('hidden')`, 20_000);
}

function createCodexFixture(scratch, helperSha256, installedMarketplace) {
  const codexHome = join(scratch, "codex-home");
  const bin = join(scratch, "bin");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), "model = \"fixture\"\n", "utf8");
  const installed = { installed: [{ pluginId: "brainpet-codex-bridge@brainpet", name: "brainpet-codex-bridge", marketplaceName: "brainpet", version: brainPetDistributionContract.bridge.version, installed: true, enabled: true }], available: [] };
  writeFileSync(join(codexHome, "fixture-installed.json"), `${JSON.stringify(installed)}\n`, "utf8");
  writeFileSync(join(codexHome, "fixture-installed-current.json"), `${JSON.stringify(installed)}\n`, "utf8");
  if (installedMarketplace) writeFileSync(join(codexHome, "fixture-marketplaces.json"), `${JSON.stringify({ marketplaces: [{ name: "brainpet", root: installedMarketplace }] })}\n`, "utf8");
  const environment = { CODEX_HOME: codexHome, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, BRAINPET_FIXTURE_HELPER_SHA256: helperSha256 };
  if (!installedMarketplace && process.platform === "linux") environment.APPIMAGE_EXTRACT_AND_RUN = "1";
  if (process.platform === "win32") {
    writeFileSync(join(bin, "codex.cmd"), windowsCodexFixture(), "utf8");
  } else {
    const script = join(bin, "codex");
    writeFileSync(script, unixCodexFixture(), { encoding: "utf8", mode: 0o755 });
    chmodSync(script, 0o755);
  }
  return { environment, codexHome };
}

function setFixtureInstalledVersion(codexHome, version) {
  assert.match(version, /^[a-z0-9._+-]{1,64}$/i);
  const installed = { installed: [{ pluginId: "brainpet-codex-bridge@brainpet", name: "brainpet-codex-bridge", marketplaceName: "brainpet", version, installed: true, enabled: true }], available: [] };
  writeFileSync(join(codexHome, "fixture-installed.json"), `${JSON.stringify(installed)}\n`, "utf8");
}

function windowsCodexFixture() {
  return `@echo off\r\nsetlocal\r\necho %*>>"%CODEX_HOME%\\fixture-commands.log"\r\nif "%~1"=="--version" goto version\r\nif "%~1 %~2 %~3"=="plugin list --json" goto plugin_list\r\nif "%~1 %~2 %~3 %~4"=="plugin marketplace list --json" goto marketplace_list\r\nif "%~1 %~2 %~3"=="plugin marketplace add" goto marketplace_add\r\nif "%~1 %~2 %~3"=="plugin marketplace remove" goto marketplace_remove\r\nif "%~1 %~2"=="plugin add" goto plugin_add\r\nif "%~1 %~2"=="plugin remove" goto plugin_remove\r\ngoto unsupported\r\n:version\r\necho codex-cli 0.147.0\r\nexit /b 0\r\n:plugin_list\r\nif exist "%CODEX_HOME%\\fixture-plugin.enabled" (type "%CODEX_HOME%\\fixture-installed.json") else (echo {"installed":[],"available":[]})\r\nexit /b 0\r\n:marketplace_list\r\nif exist "%CODEX_HOME%\\fixture-marketplace.enabled" (type "%CODEX_HOME%\\fixture-marketplaces.json") else (echo {"marketplaces":[]})\r\nexit /b 0\r\n:marketplace_add\r\ntype nul >"%CODEX_HOME%\\fixture-marketplace.enabled"\r\necho {}\r\nexit /b 0\r\n:marketplace_remove\r\ndel /q "%CODEX_HOME%\\fixture-marketplace.enabled" 2>nul\r\necho {}\r\nexit /b 0\r\n:plugin_add\r\ncopy /y "%CODEX_HOME%\\fixture-installed-current.json" "%CODEX_HOME%\\fixture-installed.json" >nul\r\ntype nul >"%CODEX_HOME%\\fixture-plugin.enabled"\r\necho {}\r\nexit /b 0\r\n:plugin_remove\r\ndel /q "%CODEX_HOME%\\fixture-plugin.enabled" 2>nul\r\necho {}\r\nexit /b 0\r\n:unsupported\r\necho unsupported fixture command 1>&2\r\nexit /b 2\r\n`;
}

function unixCodexFixture() {
  return `#!/bin/sh\nprintf '%s\\n' "$*" >>"$CODEX_HOME/fixture-commands.log"\nif [ "$1" = "--version" ]; then printf 'codex-cli 0.147.0\\n'; exit 0; fi\nif [ "$1 $2 $3" = "plugin list --json" ]; then if [ -f "$CODEX_HOME/fixture-plugin.enabled" ]; then cat "$CODEX_HOME/fixture-installed.json"; else printf '{"installed":[],"available":[]}\\n'; fi; exit 0; fi\nif [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then if [ -f "$CODEX_HOME/fixture-marketplace.enabled" ]; then cat "$CODEX_HOME/fixture-marketplaces.json"; else printf '{"marketplaces":[]}\\n'; fi; exit 0; fi\nif [ "$1 $2 $3" = "plugin marketplace add" ]; then printf '{"marketplaces":[{"name":"brainpet","root":"%s"}]}\\n' "$4" >"$CODEX_HOME/fixture-marketplaces.json"; touch "$CODEX_HOME/fixture-marketplace.enabled"; printf '{}\\n'; exit 0; fi\nif [ "$1 $2 $3" = "plugin marketplace remove" ]; then rm -f "$CODEX_HOME/fixture-marketplace.enabled"; printf '{}\\n'; exit 0; fi\nif [ "$1 $2" = "plugin add" ]; then cp "$CODEX_HOME/fixture-installed-current.json" "$CODEX_HOME/fixture-installed.json"; touch "$CODEX_HOME/fixture-plugin.enabled"; printf '{}\\n'; exit 0; fi\nif [ "$1 $2" = "plugin remove" ]; then rm -f "$CODEX_HOME/fixture-plugin.enabled"; printf '{}\\n'; exit 0; fi\nprintf 'unsupported fixture command\\n' >&2\nexit 2\n`;
}

function runHelper(helper, environment, hookName, sessionId) {
  const minimalPath = process.platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32;${process.env.SystemRoot ?? "C:\\Windows"}`
    : "/usr/bin:/bin:/usr/sbin:/sbin";
  const result = spawnSync(helper, ["--agent", "codex"], {
    input: JSON.stringify({ hook_event_name: hookName, session_id: sessionId, prompt: "must-not-leave-helper", cwd: "/private" }),
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    env: { ...process.env, ...environment, PATH: minimalPath, NODE: undefined, NODE_PATH: undefined, CARGO_HOME: undefined, RUSTUP_HOME: undefined },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || "Packaged helper failed to fail open.");
}

function readAdapterReceipt(userData, operation) {
  const receipt = readJson(join(userData, "adapter-receipts", "codex-latest.json"));
  assert.equal(receipt.operation, operation);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.product, "brainpet");
  return receipt;
}

function readInstallationState(userData) {
  return readJson(join(userData, "brainpet-installation-state.json"));
}

async function waitForInstallationState(userData, predicate, timeoutMs) {
  const path = join(userData, "brainpet-installation-state.json");
  return waitForJson(path, predicate, timeoutMs);
}

async function terminateInstalledRuntime(executable) {
  if (process.platform === "win32") {
    const script = "$target = [System.IO.Path]::GetFullPath($env:BRAINPET_CI_EXECUTABLE); $matches = { @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetFullPath($_.ExecutablePath), $target) }) }; & $matches | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $deadline = [DateTime]::UtcNow.AddSeconds(10); do { $remaining = & $matches; if ($remaining.Count -eq 0) { exit 0 }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline); Write-Error \"BrainPet process tree remained after termination: $($remaining.ProcessId -join ',')\"; exit 1";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, BRAINPET_CI_EXECUTABLE: executable }, encoding: "utf8", timeout: 20_000, windowsHide: true });
    assert.equal(result.status, 0, result.error?.message || result.stderr || "Unable to terminate the installed BrainPet process tree.");
    return;
  }
  for (const pid of listUnixInstalledRuntimePids(executable)) { try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ } }
  let deadline = Date.now() + 5_000;
  while (Date.now() < deadline && listUnixInstalledRuntimePids(executable).length > 0) await delay(100);
  for (const pid of listUnixInstalledRuntimePids(executable)) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
  deadline = Date.now() + 5_000;
  let remaining = listUnixInstalledRuntimePids(executable);
  while (Date.now() < deadline && remaining.length > 0) {
    await delay(100);
    remaining = listUnixInstalledRuntimePids(executable);
  }
  assert.deepEqual(remaining, [], `BrainPet process tree remained after termination: ${remaining.join(",")}`);
}

async function terminateDiscoveredRuntime(discovery, executable) {
  assert.ok(Number.isSafeInteger(discovery.pid) && discovery.pid > 0, "BrainPet discovery PID is invalid.");
  if (process.platform !== "win32" && isProcessAlive(discovery.pid)) {
    try { process.kill(discovery.pid, "SIGTERM"); } catch { /* already exited */ }
    let deadline = Date.now() + 5_000;
    while (Date.now() < deadline && isProcessAlive(discovery.pid)) await delay(100);
    if (isProcessAlive(discovery.pid)) {
      try { process.kill(discovery.pid, "SIGKILL"); } catch { /* already exited */ }
      deadline = Date.now() + 5_000;
      while (Date.now() < deadline && isProcessAlive(discovery.pid)) await delay(100);
    }
  }
  await terminateInstalledRuntime(executable);
  assert.equal(isProcessAlive(discovery.pid), false, `BrainPet discovery PID ${discovery.pid} remained after termination.`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (process.platform === "win32" && error?.code === "EINVAL") return false;
    throw error;
  }
}

function listUnixInstalledRuntimePids(executable) {
  const listed = spawnSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.error?.message || listed.stderr || "Unable to inspect the installed BrainPet process tree.");
  return listed.stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && match[2].includes(executable) ? [Number(match[1])] : [];
  }).filter((pid) => pid !== process.pid);
}

function runRequired(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: options.timeout ?? 30_000, cwd: options.cwd, env: options.env ?? process.env });
  assert.equal(result.status, 0, result.error?.message || result.stderr || `${command} ${args.join(" ")} failed.`);
  return result;
}

function findFiles(directory, predicate) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return findFiles(path, predicate);
    return entry.isFile() && predicate(entry.name) ? [path] : [];
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return address.port;
}

async function waitForTarget(debugPort, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1_000) });
      const targets = await response.json();
      const target = targets.find(predicate);
      if (target) return target;
    } catch { /* app is starting */ }
    await delay(100);
  }
  throw new Error("Timed out waiting for packaged BrainPet setup UI.");
}

async function evaluate(target, expression) {
  const result = await sendCdp(target.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Packaged setup evaluation failed.");
  return result.result?.value;
}

async function waitForEvaluation(target, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(target, expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for setup state: ${expression}`);
}

function sendCdp(webSocketUrl, method, params) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`CDP command timed out: ${method}`)); }, 10_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolvePromise(message.result);
    });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error(`CDP socket failed: ${method}`)); });
  });
}

async function waitForJson(path, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = readJson(path);
      if (predicate(value)) return value;
    } catch { /* file is not ready */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for JSON evidence: ${path}`);
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for file: ${path}`);
}

async function waitForMissing(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for cleanup: ${path}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolvePromise(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function readJson(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxReceiptBytes, `Unsafe or oversized JSON evidence: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertRegularFile(path, label) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file: ${path}`);
}

function summarizeArtifact(packageInfo) {
  return { version: packageInfo.receipt.appVersion, name: basename(packageInfo.artifact.path), bytes: packageInfo.artifact.bytes, sha256: packageInfo.artifact.sha256 };
}

function hashFile(path) {
  return hashBytes(readFileSync(path));
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareVersions(left, right) {
  const parse = (value) => value.split("-")[0].split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return left.localeCompare(right);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
