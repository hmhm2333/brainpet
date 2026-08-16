#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { brainPetPhysicalCheckIds, validateBrainPetPhysicalReceipt } from "../../../scripts/brainpet-physical-receipt-contract.mjs";

export async function runMacosPhysicalAcceptance(options) {
  assert.equal(process.platform, "darwin", "macOS physical acceptance must run on macOS.");
  assert.equal(process.arch, "arm64", "macOS Stable physical acceptance requires Apple Silicon.");
  assert.match(options.sourceCommit ?? "", /^[a-f0-9]{40}$/i, "Physical acceptance requires the exact release commit.");
  const artifactPath = resolve(options.artifactPath);
  const bytes = readFileSync(artifactPath);
  assert.ok(bytes.length >= 16 * 1024, "BrainPet DMG is implausibly small.");
  assert.equal(bytes.toString("ascii", bytes.length - 512, bytes.length - 508), "koly", "BrainPet physical artifact is not a structurally valid DMG.");
  const gatekeeper = spawnSync("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", artifactPath], { encoding: "utf8", timeout: 30_000 });
  const stapler = spawnSync("xcrun", ["stapler", "validate", artifactPath], { encoding: "utf8", timeout: 30_000 });
  const developerId = spawnSync("codesign", ["--display", "--verbose=4", artifactPath], { encoding: "utf8", timeout: 30_000 });
  for (const [label, result] of [["Gatekeeper", gatekeeper], ["stapler", stapler], ["Developer ID", developerId]]) {
    assert.equal(result.error, undefined, `Unable to run the macOS ${label} probe.`);
    assert.ok(Number.isInteger(result.status), `macOS ${label} probe did not return an exit status.`);
  }
  const developerIdOutput = `${developerId.stdout ?? ""}\n${developerId.stderr ?? ""}`;
  assert.doesNotMatch(developerIdOutput, /Authority=Developer ID Application:/, "Unsigned BrainPet DMG unexpectedly contains a Developer ID signature.");
  const displays = readMacDisplays();
  const startedAt = new Date().toISOString();
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const reviewer = boundedRequired(await prompt.question("Reviewer identifier: "), 128, "Reviewer identifier");
    const checks = [];
    for (const id of brainPetPhysicalCheckIds) checks.push(await readCheck(prompt, id, physicalPrompt(id)));
    const receipt = {
      schemaVersion: 4,
      scriptVersion: "brainpet-release-v4.0",
      product: "brainpet",
      target: "macos-arm64",
      sourceCommit: options.sourceCommit.toLowerCase(),
      runId: randomUUID(),
      startedAt,
      completedAt: new Date().toISOString(),
      mode: "interactive",
      reviewer,
      overallStatus: gatekeeper.status !== 0 && stapler.status !== 0 && displays.length >= 2 && checks.every((check) => check.status === "pass") ? "passed" : "incomplete",
      distributionChannel: "direct-download",
      platformSignatureStatus: "absent-by-policy",
      systemWarningObserved: checks.find((check) => check.id === "unsigned-security-prompt")?.status === "pass",
      userConsentConfirmed: checks.find((check) => check.id === "unsigned-security-prompt")?.status === "pass",
      environment: { platform: process.platform, arch: process.arch, displayCount: displays.length, displays },
      artifact: {
        kind: "dmg",
        name: basename(artifactPath),
        sizeBytes: lstatSync(artifactPath).size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        developerIdStatus: "Absent",
        gatekeeperStatus: gatekeeper.status === 0 ? "Accepted" : "Rejected",
        staplerStatus: stapler.status === 0 ? "Valid" : "Invalid",
      },
      checks,
    };
    receipt.artifactSha256 = receipt.artifact.sha256;
    if (receipt.overallStatus === "passed") validateBrainPetPhysicalReceipt(receipt, { expectedSourceCommit: options.sourceCommit });
    const outputRoot = resolve(options.outputRoot);
    mkdirSync(outputRoot, { recursive: true });
    const jsonPath = resolve(outputRoot, "brainpet-physical-receipt.json");
    const markdownPath = resolve(outputRoot, "brainpet-physical-receipt.md");
    writeFileSync(jsonPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    writeFileSync(markdownPath, renderMarkdown(receipt), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { receipt, jsonPath, markdownPath };
  } finally {
    prompt.close();
  }
}

function readMacDisplays() {
  const result = spawnSync("system_profiler", ["SPDisplaysDataType", "-json"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.error?.message || "Unable to inventory macOS displays.");
  const data = JSON.parse(result.stdout);
  return (data.SPDisplaysDataType ?? []).flatMap((adapter) => adapter.spdisplays_ndrvs ?? []).map((display, index) => ({
    index: index + 1,
    name: bounded(String(display._name ?? `Display ${index + 1}`), 128),
    resolution: bounded(String(display._spdisplays_resolution ?? "unknown"), 128),
    main: display.spdisplays_main === "spdisplays_yes",
    online: display.spdisplays_online === "spdisplays_yes",
  }));
}

async function readCheck(prompt, id, message) {
  stdout.write(`\n${message}\n`);
  let status;
  do status = (await prompt.question("Enter PASS or FAIL: ")).trim().toLowerCase(); while (!["pass", "fail"].includes(status));
  const note = bounded(await prompt.question("Optional non-sensitive note: "), 500);
  return { id, status, note };
}

function physicalPrompt(id) {
  const prompts = {
    "unsigned-security-prompt": "Open the browser-downloaded Unsigned DMG. Confirm macOS blocks or warns first, then use the system-provided Open/Open Anyway flow deliberately; do not use Terminal or disable Gatekeeper.",
    "clean-install": "Install the Unsigned DMG as a new user and confirm setup requires no terminal after the one-time system confirmation.",
    "default-install-path": "Confirm BrainPet runs from /Applications/BrainPet.app.",
    "no-development-toolchain": "Confirm lifecycle and training work without Node, npm, pnpm, or Rust on PATH.",
    "default-discovery": "Confirm the packaged Adapter finds BrainPet without a discovery override.",
    "adapter-first-lifecycle": "Run a real Agent task and confirm its first lifecycle event wakes and updates one BrainPet instance.",
    "upgrade-state-preserved": "Upgrade from the prior unsigned candidate and confirm progress plus Adapter connection are preserved or refreshed once.",
    "uninstall-agent-fail-open": "Uninstall BrainPet and confirm the Agent continues normally without Hook errors.",
    "native-pet-recovery": "Confirm uninstall does not remove or alter the Agent's native pet resources.",
    "primary-display-edges": "Move the pet to all primary-display edges and verify stage bounds.",
    "secondary-display-edges": "Repeat the edge and stage check on a second physical display.",
    "mixed-dpi": "Verify stage size, pixel edges, and hit targets across two displays with different scaling.",
    "sleep-wake": "Sleep and wake macOS during a task; confirm safe pause/resume and one runtime instance.",
    "agent-completion": "Complete a real Agent task during training; confirm the training session is not reset.",
    "novice-rule-comprehension": "Confirm a first-time player can explain and perform every level-1 rule without external instructions.",
    "dynamic-visual": "Play every task and verify no overflow, flicker, blurred pixels, or accidental native controls.",
  };
  return prompts[id];
}

function bounded(value, maxLength) {
  return value.trim().replace(/[\r\n]+/g, " ").slice(0, maxLength);
}

function boundedRequired(value, maxLength, label) {
  const result = bounded(value, maxLength);
  assert.ok(result.length > 0, `${label} is required.`);
  return result;
}

function renderMarkdown(receipt) {
  return `# BrainPet physical acceptance receipt\n\n- Target: ${receipt.target}\n- Commit: ${receipt.sourceCommit}\n- Status: ${receipt.overallStatus}\n- Artifact SHA256: ${receipt.artifactSha256}\n- Reviewer: ${receipt.reviewer}\n\n## Checks\n\n${receipt.checks.map((check) => `- ${check.id}: ${check.status}${check.note ? ` — ${check.note}` : ""}`).join("\n")}\n`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--artifact") options.artifactPath = argv[++index];
    else if (argv[index] === "--source-commit") options.sourceCommit = argv[++index];
    else if (argv[index] === "--output") options.outputRoot = argv[++index];
    else throw new Error(`Unknown macOS physical acceptance argument: ${argv[index]}`);
  }
  assert.ok(options.artifactPath && options.sourceCommit && options.outputRoot, "Usage: brainpet-macos-physical-acceptance.mjs --artifact <BrainPet.dmg> --source-commit <sha> --output <new-dir>");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMacosPhysicalAcceptance(parseArgs(process.argv.slice(2))).then(({ receipt, jsonPath }) => {
    console.log(`BrainPet macOS physical acceptance ${receipt.overallStatus}: ${jsonPath}`);
    if (receipt.overallStatus !== "passed") process.exitCode = 2;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
