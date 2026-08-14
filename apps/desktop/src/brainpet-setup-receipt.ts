export interface BrainPetSetupReceipt {
  readonly runtime: "installed" | "development" | "missing";
  readonly bridge: "needs-codex-confirmation";
  readonly nextTask: "manual-check";
}

export function createBrainPetSetupReceipt(input: { readonly packaged: boolean; readonly markerExists: boolean }): BrainPetSetupReceipt {
  return {
    runtime: input.packaged && input.markerExists ? "installed" : input.packaged ? "missing" : "development",
    bridge: "needs-codex-confirmation",
    nextTask: "manual-check",
  };
}
