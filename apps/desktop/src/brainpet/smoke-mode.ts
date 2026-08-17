export const BRAINPET_ACTIVE_SOAK_GATE_MS = 30 * 60 * 1_000;
export const BRAINPET_IDLE_SOAK_GATE_MS = 24 * 60 * 60 * 1_000;

export type BrainPetPerformanceGateProfile = "active-30m" | "idle-24h";

export interface BrainPetSmokeModeInput {
  readonly activeSoakMs: number;
  readonly idleSoakMs: number;
  readonly gateProfile?: string;
  readonly expectDisabled: boolean;
  readonly verifyOpenPetsIsolation: boolean;
  readonly platform: NodeJS.Platform;
}

export interface BrainPetSmokeMode {
  readonly performanceKind: "none" | "active" | "idle";
  readonly gateProfile: BrainPetPerformanceGateProfile | "probe" | null;
  readonly gatePassedEligible: boolean;
}

export const BRAINPET_HEAP_SAMPLE_RETRY_ATTEMPTS = 3;
export const BRAINPET_HEAP_SAMPLE_RETRY_DELAY_MS = 100;
export const BRAINPET_IDLE_SETTLEMENT_STABLE_MS = 2_000;

export interface BrainPetIdleSettlementObservation {
  readonly observedAtMs: number;
  readonly targetIds: readonly string[];
  readonly processes: readonly {
    readonly pid: number;
    readonly creationTime: string;
    readonly role: string;
  }[];
}

export interface BrainPetIdleSettlementState {
  readonly signature: string;
  readonly stableSinceMs: number;
}

export function advanceBrainPetIdleSettlement(
  previous: BrainPetIdleSettlementState | null,
  observation: BrainPetIdleSettlementObservation,
): { readonly state: BrainPetIdleSettlementState | null; readonly settled: boolean } {
  const identities = observation.processes.map(({ pid, creationTime, role }) => `${pid}@${creationTime}:${role}`);
  const valid = observation.targetIds.length === 1
    && observation.processes.filter(({ role }) => role === "browser").length === 1
    && observation.processes.filter(({ role }) => role === "renderer").length === 1
    && identities.length > 0
    && new Set(identities).size === identities.length;
  if (!valid) return { state: null, settled: false };
  const signature = JSON.stringify([observation.targetIds[0], identities.sort()]);
  if (!previous || previous.signature !== signature) {
    return { state: { signature, stableSinceMs: observation.observedAtMs }, settled: false };
  }
  return {
    state: previous,
    settled: observation.observedAtMs - previous.stableSinceMs >= BRAINPET_IDLE_SETTLEMENT_STABLE_MS,
  };
}

export function isTransientBrainPetHeapSampleError(error: unknown): boolean {
  return error instanceof Error
    && /^CDP (?:socket failed|command timed out): Runtime\.getHeapUsage$/.test(error.message);
}

export async function retryBrainPetHeapSample<T>(
  sample: () => Promise<T>,
  wait: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
): Promise<T> {
  for (let attempt = 1; attempt <= BRAINPET_HEAP_SAMPLE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await sample();
    } catch (error) {
      if (!isTransientBrainPetHeapSampleError(error) || attempt === BRAINPET_HEAP_SAMPLE_RETRY_ATTEMPTS) throw error;
      await wait(BRAINPET_HEAP_SAMPLE_RETRY_DELAY_MS);
    }
  }
  throw new Error("BrainPet heap sample retry exhausted without an error.");
}

export function resolveBrainPetSmokeMode(input: BrainPetSmokeModeInput): BrainPetSmokeMode {
  const hasActiveSoak = input.activeSoakMs > 0;
  const hasIdleSoak = input.idleSoakMs > 0;
  if (hasActiveSoak && hasIdleSoak) throw new Error("BrainPet active and idle soak modes are mutually exclusive.");
  const performanceKind = hasActiveSoak ? "active" : hasIdleSoak ? "idle" : "none";
  if (performanceKind !== "none" && (input.expectDisabled || input.verifyOpenPetsIsolation)) {
    throw new Error("BrainPet performance soak cannot run in rollback or OpenPets isolation mode.");
  }
  if (!input.gateProfile) {
    return { performanceKind, gateProfile: performanceKind === "none" ? null : "probe", gatePassedEligible: false };
  }
  if (input.gateProfile !== "active-30m" && input.gateProfile !== "idle-24h") throw new Error("Unknown BrainPet performance gate profile.");
  if (input.platform !== "win32") throw new Error("BrainPet long-soak process-tree evidence currently requires Windows; macOS arm64 needs an independent physical receipt.");
  if (input.gateProfile === "active-30m") {
    if (performanceKind !== "active" || input.activeSoakMs !== BRAINPET_ACTIVE_SOAK_GATE_MS) throw new Error("BrainPet active-30m gate requires exactly 30 minutes of active soak.");
  } else if (performanceKind !== "idle" || input.idleSoakMs !== BRAINPET_IDLE_SOAK_GATE_MS) {
    throw new Error("BrainPet idle-24h gate requires exactly 24 hours of idle soak.");
  }
  return { performanceKind, gateProfile: input.gateProfile, gatePassedEligible: true };
}
