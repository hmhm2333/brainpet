import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
const script = readFileSync(resolve(desktopRoot, "scripts/brainpet-physical-acceptance.ps1"), "utf8");

test("physical acceptance harness is receipt-driven and does not automate destructive system actions", () => {
  assert.match(script, /brainpet-physical-receipt\.json/);
  assert.match(script, /InventoryOnly/);
  assert.match(script, /RunInteractive/);
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /GetEffectiveDpi/);
  assert.match(script, /schemaVersion = 2/);
  assert.match(script, /TargetId/);
  assert.match(script, /artifactSha256/);
  assert.doesNotMatch(script, /LockWorkStation|rundll32|Set-DisplayResolution|Stop-Process|Remove-Item/);
});

test("interactive receipt covers the unresolved physical release checks", () => {
  for (const check of ["secondary-display-edges", "mixed-dpi", "lock-unlock", "agent-completion", "parameter-owner-approval", "novice-rule-comprehension", "dynamic-visual"]) {
    assert.match(script, new RegExp(check));
  }
  assert.match(script, /overallStatus = if \(\$requiredPassed/);
});
