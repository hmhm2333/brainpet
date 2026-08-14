import type { BrainPetTaskSessionConfig } from "./task-contract.js";

export function matchesIssuedBrainPetSession(issued: BrainPetTaskSessionConfig | null, candidate: unknown): candidate is BrainPetTaskSessionConfig {
  if (!issued || !isRecord(candidate)) return false;
  return candidate.taskId === issued.taskId
    && candidate.seed === issued.seed
    && candidate.durationMs === issued.durationMs
    && candidate.level === issued.level
    && candidate.difficultyPolicyVersion === issued.difficultyPolicyVersion
    && candidate.parameterVersion === issued.parameterVersion
    && candidate.blockCount === issued.blockCount
    && isParameterVector(candidate.parameters)
    && parameterVectorsEqual(candidate.parameters, issued.parameters);
}

function isParameterVector(value: unknown): value is Record<string, number | string | boolean> {
  return isRecord(value) && Object.keys(value).length <= 16 && Object.entries(value).every(([key, item]) => /^[a-z][A-Za-z0-9]{0,31}$/.test(key) && (typeof item === "number" && Number.isFinite(item) || typeof item === "string" && item.length <= 64 || typeof item === "boolean"));
}

function parameterVectorsEqual(left: Record<string, number | string | boolean>, right: Readonly<Record<string, number | string | boolean>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
