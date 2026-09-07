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
    integration: "Shared catalog live; in-app launcher rollout",
    state: "in_progress",
    stateLabel: "Deploying",
  },
  breathe: {
    previousHelp: "Admin and patient help surfaces",
    integration: "Admin launcher with local fallback",
    state: "live",
    stateLabel: "Live",
  },
  pennsync: {
    previousHelp: "Static and local help surfaces",
    integration: "Contextual launcher with local fallback",
    state: "in_progress",
    stateLabel: "Published; click pending",
  },
  "caremetric-emr": {
    previousHelp: "Local support center",
    integration: "Dashboard launcher with local fallback",
    state: "live",
    stateLabel: "Live",
  },
  "caremetric-go": {
    previousHelp: "Separate provider and patient menus",
    integration: "Shared support screen with offline fallback",
    state: "source_ready",
    stateLabel: "Source ready",
  },
  "caremetric-intel": {
    previousHelp: "In-app searchable product guide",
    integration: "Central launcher and guide import audit",
    state: "in_progress",
    stateLabel: "Auditing",
  },
};

export const defaultIntegrationRollout: IntegrationRollout = {
  previousHelp: "Product-owned help",
  integration: "Safe central launcher with local fallback",
  state: "blocked",
  stateLabel: "Not verified",
};
