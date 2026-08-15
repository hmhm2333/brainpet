import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
const script = readFileSync(resolve(desktopRoot, "scripts/brainpet-physical-acceptance.ps1"), "utf8");
const macScript = readFileSync(resolve(desktopRoot, "scripts/brainpet-macos-physical-acceptance.mjs"), "utf8");
const repoRoot = resolve(desktopRoot, "../..");
const intakeWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/brainpet-physical-receipt-intake.yml"), "utf8");
const publicWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/brainpet-public-release-gate.yml"), "utf8");
const finalizeWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/brainpet-public-release-finalize.yml"), "utf8");
const subjectCollector = readFileSync(resolve(repoRoot, "scripts/collect-brainpet-subject-provenance.mjs"), "utf8");

test("physical acceptance harness is receipt-driven and does not automate destructive system actions", () => {
  assert.match(script, /brainpet-physical-receipt\.json/);
  assert.match(script, /InventoryOnly/);
  assert.match(script, /RunInteractive/);
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /GetEffectiveDpi/);
  assert.match(script, /schemaVersion = 3/);
  assert.match(script, /TargetId/);
  assert.match(script, /SourceCommit/);
  assert.match(script, /authenticodeStatus/);
  assert.match(script, /artifactSha256/);
  assert.doesNotMatch(script, /path = \$resolved/);
  assert.doesNotMatch(script, /LockWorkStation|rundll32|Set-DisplayResolution|Stop-Process|Remove-Item/);
});

test("interactive receipts cover release lifecycle and physical checks", () => {
  for (const check of ["clean-install", "default-install-path", "no-development-toolchain", "default-discovery", "adapter-first-lifecycle", "upgrade-state-preserved", "uninstall-agent-fail-open", "native-pet-recovery", "secondary-display-edges", "mixed-dpi", "sleep-wake", "agent-completion", "novice-rule-comprehension", "dynamic-visual"]) {
    assert.match(script, new RegExp(check));
    assert.match(macScript, new RegExp(check));
  }
  assert.match(script, /overallStatus = if \(\$requiredPassed/);
  assert.match(macScript, /spctl/);
  assert.match(macScript, /stapler/);
  assert.match(macScript, /system_profiler/);
});

test("physical evidence enters the public gate only through the dedicated intake workflow", () => {
  assert.match(intakeWorkflow, /name: BrainPet physical receipt intake/);
  assert.match(intakeWorkflow, /brainpet-physical-receipts/);
  assert.match(intakeWorkflow, /--require-trusted-ci/);
  assert.doesNotMatch(publicWorkflow, /physical_receipt_run_id/);
  assert.match(publicWorkflow, /brainpet-public-candidate-receipt/);
  assert.match(publicWorkflow, /collect-brainpet-subject-provenance\.mjs/);
  assert.doesNotMatch(publicWorkflow, /cat sha256-/);
  assert.match(subjectCollector, /sha256\[-:\]/);
  assert.match(finalizeWorkflow, /download-brainpet-public-candidate\.mjs/);
  assert.match(finalizeWorkflow, /download-brainpet-physical-receipts\.mjs/);
  assert.match(finalizeWorkflow, /--expect-public-ready/);
});
