import { brainPetBridgeVersion, type BrainPetInstallationState } from "./brainpet-installation-state.js";

export interface BrainPetSetupReceipt {
  readonly runtime: "installed" | "development" | "missing";
  readonly bridge: "verified" | "needs-codex-confirmation" | "reauthorization-required";
  readonly nextTask: "manual-check" | "verified";
}

export function createBrainPetSetupReceipt(input: { readonly packaged: boolean; readonly markerValid: boolean; readonly state?: BrainPetInstallationState }): BrainPetSetupReceipt {
  const bridge = !input.state?.bridgeConfirmedVersion
    ? "needs-codex-confirmation"
    : input.state.bridgeConfirmedVersion !== brainPetBridgeVersion
      ? "reauthorization-required"
      : "verified";
  return {
    runtime: input.packaged && input.markerValid ? "installed" : input.packaged ? "missing" : "development",
    bridge,
    nextTask: input.state?.lifecycleVerifiedAt
      && input.state.lifecycleVerifiedBridgeVersion === brainPetBridgeVersion
      && input.state.bridgeConfirmedVersion === brainPetBridgeVersion
      && input.state.bridgeConfirmedAt !== null
      && input.state.lifecycleVerifiedAt >= input.state.bridgeConfirmedAt
      ? "verified"
      : "manual-check",
  };
}
