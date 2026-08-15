import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export { brainPetBridgeVersion } from "./generated-brainpet-distribution.js";
import { brainPetBridgeVersion } from "./generated-brainpet-distribution.js";
const schemaVersion = 2;

export interface BrainPetInstallationState {
  readonly schemaVersion: 2;
  readonly runtimeVersion: string | null;
  readonly runtimeReadyAt: number | null;
  readonly bridgeConfirmedVersion: string | null;
  readonly bridgeConfirmedAt: number | null;
  readonly lifecycleVerifiedAt: number | null;
  readonly lifecycleVerifiedBridgeVersion: string | null;
}

const emptyState: BrainPetInstallationState = {
  schemaVersion,
  runtimeVersion: null,
  runtimeReadyAt: null,
  bridgeConfirmedVersion: null,
  bridgeConfirmedAt: null,
  lifecycleVerifiedAt: null,
  lifecycleVerifiedBridgeVersion: null,
};

let statePath: string | null = null;
let currentState: BrainPetInstallationState = emptyState;

export function initializeBrainPetInstallationState(userDataPath: string): BrainPetInstallationState {
  statePath = join(userDataPath, "brainpet-installation-state.json");
  currentState = readState(statePath);
  return getBrainPetInstallationState();
}

export function getBrainPetInstallationState(): BrainPetInstallationState {
  return structuredClone(currentState);
}

export function recordBrainPetRuntimeReady(runtimeVersion: string, now = Date.now()): BrainPetInstallationState {
  return updateState({ ...currentState, runtimeVersion, runtimeReadyAt: now });
}

export function confirmBrainPetBridge(version: string = brainPetBridgeVersion, now = Date.now()): BrainPetInstallationState {
  const versionChanged = currentState.bridgeConfirmedVersion !== version;
  return updateState({
    ...currentState,
    bridgeConfirmedVersion: version,
    bridgeConfirmedAt: now,
    lifecycleVerifiedAt: versionChanged ? null : currentState.lifecycleVerifiedAt,
    lifecycleVerifiedBridgeVersion: versionChanged ? null : currentState.lifecycleVerifiedBridgeVersion,
  });
}

export function clearBrainPetBridgeConfirmation(): BrainPetInstallationState {
  return updateState({
    ...currentState,
    bridgeConfirmedVersion: null,
    bridgeConfirmedAt: null,
    lifecycleVerifiedAt: null,
    lifecycleVerifiedBridgeVersion: null,
  });
}

export function recordBrainPetLifecycleVerified(now = Date.now(), version: string = brainPetBridgeVersion): BrainPetInstallationState {
  if (currentState.bridgeConfirmedVersion !== version || currentState.bridgeConfirmedAt === null || now < currentState.bridgeConfirmedAt) return getBrainPetInstallationState();
  return updateState({ ...currentState, lifecycleVerifiedAt: now, lifecycleVerifiedBridgeVersion: version });
}

export function normalizeBrainPetInstallationState(value: unknown): BrainPetInstallationState {
  if (!isRecord(value) || value.schemaVersion !== 1 && value.schemaVersion !== schemaVersion) return emptyState;
  const lifecycleVerifiedAt = value.schemaVersion === schemaVersion ? normalizeTimestamp(value.lifecycleVerifiedAt) : null;
  const lifecycleVerifiedBridgeVersion = value.schemaVersion === schemaVersion ? normalizeVersion(value.lifecycleVerifiedBridgeVersion) : null;
  return {
    schemaVersion,
    runtimeVersion: normalizeVersion(value.runtimeVersion),
    runtimeReadyAt: normalizeTimestamp(value.runtimeReadyAt),
    bridgeConfirmedVersion: normalizeVersion(value.bridgeConfirmedVersion),
    bridgeConfirmedAt: normalizeTimestamp(value.bridgeConfirmedAt),
    lifecycleVerifiedAt,
    lifecycleVerifiedBridgeVersion,
  };
}

export function resetBrainPetInstallationStateForTests(): void {
  statePath = null;
  currentState = emptyState;
}

function updateState(next: BrainPetInstallationState): BrainPetInstallationState {
  currentState = normalizeBrainPetInstallationState(next);
  if (statePath) writeState(statePath, currentState);
  return getBrainPetInstallationState();
}

function readState(path: string): BrainPetInstallationState {
  if (!existsSync(path)) return emptyState;
  try {
    return normalizeBrainPetInstallationState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyState;
  }
}

function writeState(path: string, state: BrainPetInstallationState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
  try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
}

function normalizeVersion(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !/[\0\r\n]/.test(value) ? value : null;
}

function normalizeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
