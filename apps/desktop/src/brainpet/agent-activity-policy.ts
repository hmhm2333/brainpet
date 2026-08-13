export interface BrainPetAgentActivity {
  readonly kind: string;
  readonly reaction?: string;
  readonly surface: "default" | "agent";
}

export function parseBrainPetAgentActivity(value: Record<string, unknown>): BrainPetAgentActivity | null {
  if (typeof value.kind !== "string") return null;
  if (value.reaction !== undefined && typeof value.reaction !== "string") return null;
  if (value.surface !== "default" && value.surface !== "agent") return null;
  return {
    kind: value.kind,
    ...(typeof value.reaction === "string" ? { reaction: value.reaction } : {}),
    surface: value.surface,
  };
}

export function isBrainPetAgentCompletion(activity: BrainPetAgentActivity): boolean {
  return activity.reaction === "success" || activity.reaction === "celebrating";
}
