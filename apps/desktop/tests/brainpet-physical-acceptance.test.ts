import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const script = readFileSync(resolve("scripts/brainpet-physical-acceptance.ps1"), "utf8");

test("physical acceptance harness is receipt-driven and does not automate destructive system actions", () => {
  assert.match(script, /brainpet-physical-receipt\.json/);
  assert.match(script, /InventoryOnly/);
  assert.match(script, /RunInteractive/);
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /GetEffectiveDpi/);
  assert.doesNotMatch(script, /LockWorkStation|rundll32|Set-DisplayResolution|Stop-Process|Remove-Item/);
});

test("interactive receipt covers the unresolved physical release checks", () => {
  for (const check of ["secondary-display-edges", "mixed-dpi", "lock-unlock", "agent-completion", "dynamic-visual"]) {
    assert.match(script, new RegExp(check));
  }
  assert.match(script, /overallStatus = if \(\$requiredPassed/);
});
