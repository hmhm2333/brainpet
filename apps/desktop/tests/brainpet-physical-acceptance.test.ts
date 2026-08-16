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
const sigstoreProvenance = readFileSync(resolve(repoRoot, "scripts/brainpet-sigstore-provenance.mjs"), "utf8");

test("physical acceptance harness is receipt-driven and does not automate destructive system actions", () => {
  assert.match(script, /brainpet-physical-receipt\.json/);
  assert.match(script, /InventoryOnly/);
  assert.match(script, /RunInteractive/);
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /GetEffectiveDpi/);
  assert.match(script, /schemaVersion = 5/);
  assert.match(script, /CandidateReceiptPath/);
  assert.match(script, /physicalChallenge/);
  assert.match(script, /candidateEvidence/);
  assert.match(script, /TargetId/);
  assert.match(script, /SourceCommit/);
  assert.match(script, /authenticodeStatus/);
  assert.match(script, /artifactSha256/);
  assert.doesNotMatch(script, /path = \$resolved/);
  assert.doesNotMatch(script, /LockWorkStation|rundll32|Set-DisplayResolution|Stop-Process|Remove-Item|Set-MpPreference/);
  assert.doesNotMatch(macScript, /spctl\s+--master-disable|xattr\s+-[cdr]/);
});

test("interactive receipts cover unsigned consent, release lifecycle and physical checks", () => {
  for (const check of ["unsigned-security-prompt", "clean-install", "default-install-path", "no-development-toolchain", "default-discovery", "adapter-first-lifecycle", "upgrade-state-preserved", "uninstall-agent-fail-open", "native-pet-recovery", "secondary-display-edges", "mixed-dpi", "sleep-wake", "agent-completion", "novice-rule-comprehension", "dynamic-visual"]) {
    assert.match(script, new RegExp(check));
    assert.match(macScript, new RegExp(check));
  }
  assert.match(script, /overallStatus = if \(\$requiredPassed/);
  assert.match(macScript, /spctl/);
  assert.match(macScript, /stapler/);
  assert.match(macScript, /developerIdStatus/);
  assert.match(macScript, /assertMacosCodeObjectIsUnsigned/);
  assert.match(macScript, /--candidate-receipt/);
  assert.match(macScript, /physicalChallenge/);
  assert.match(macScript, /system_profiler/);
});

test("physical evidence enters the public gate only through the dedicated intake workflow", () => {
  assert.match(intakeWorkflow, /name: BrainPet physical receipt intake/);
  assert.match(intakeWorkflow, /brainpet-physical-receipts/);
  assert.match(intakeWorkflow, /candidate_run_id/);
  assert.match(intakeWorkflow, /environment: brainpet-physical-acceptance/);
  assert.match(intakeWorkflow, /actions\/runs\/\$\{GITHUB_RUN_ID\}\/approvals/);
  assert.match(intakeWorkflow, /--approval-history output\/approval-history\.json/);
  assert.match(intakeWorkflow, /--candidate-receipt output\/candidate\/candidate-receipt\/brainpet-release-receipt\.json/);
  assert.match(intakeWorkflow, /--require-trusted-ci/);
  assert.match(intakeWorkflow, /brainpet-sigstore-provenance\.mjs/);
  assert.match(intakeWorkflow, /output\/sealed\/provenance/);
  assert.doesNotMatch(publicWorkflow, /physical_receipt_run_id/);
  assert.match(publicWorkflow, /brainpet-public-candidate-receipt/);
  assert.match(publicWorkflow, /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/);
  assert.match(publicWorkflow, /brainpet-sigstore-provenance\.mjs/);
  assert.match(publicWorkflow, /brainpet-public-provenance/);
  assert.doesNotMatch(publicWorkflow, /actions\/attest|gh attestation/);
  assert.match(sigstoreProvenance, /--oidc-provider", "github-actions/);
  assert.match(sigstoreProvenance, /--certificate-github-workflow-repository/);
  assert.match(sigstoreProvenance, /--certificate-github-workflow-sha/);
  assert.match(sigstoreProvenance, /RUNNER_ENVIRONMENT/);
  assert.match(finalizeWorkflow, /download-brainpet-public-candidate\.mjs/);
  assert.match(finalizeWorkflow, /download-brainpet-physical-receipts\.mjs/);
  assert.match(finalizeWorkflow, /--candidate-receipt output\/candidate\/candidate-receipt\/brainpet-release-receipt\.json/);
  assert.match(finalizeWorkflow, /--provenance output\/candidate\/provenance/);
  assert.match(finalizeWorkflow, /--physical-provenance output\/physical\/provenance/);
  assert.match(finalizeWorkflow, /--expect-public-ready/);
});
