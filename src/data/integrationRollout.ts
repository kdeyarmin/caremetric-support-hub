export type IntegrationRolloutState = "live" | "source_ready" | "in_progress" | "blocked";

export interface IntegrationRollout {
  previousHelp: string;
  integration: string;
  state: IntegrationRolloutState;
  stateLabel: string;
}

export const integrationRolloutBySlug: Record<string, IntegrationRollout> = {
  carebase: {
    previousHelp: "CareBase articles, courses, and tickets",
    integration: "Shared catalog and central Help launcher enabled",
    state: "in_progress",
    stateLabel: "Enabled; click pending",
  },
  breathe: {
    previousHelp: "Admin and patient help surfaces",
    integration: "Admin launcher with local fallback",
    state: "live",
    stateLabel: "Live",
  },
  "caremetric-intel": {
    previousHelp: "In-app searchable product guide",
    integration: "Central launcher and native self-service enabled",
    state: "live",
    stateLabel: "Live",
  },
};

export const defaultIntegrationRollout: IntegrationRollout = {
  previousHelp: "Product-owned help",
  integration: "Safe central launcher with local fallback",
  state: "blocked",
  stateLabel: "Not verified",
};
