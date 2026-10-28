import { describe, expect, it } from "vitest";
import { CAREMETRIC_PRODUCT_SLUGS } from "../../packages/help-sdk/src/index";
import { integrationRolloutBySlug } from "./integrationRollout";

describe("application integration rollout registry", () => {
  it("uses stable product slugs rather than array positions", () => {
    // Only active centralized apps have rollout entries.
    expect(Object.keys(integrationRolloutBySlug).sort()).toEqual([...CAREMETRIC_PRODUCT_SLUGS].sort());
  });

  it("distinguishes live deployments from source-only work", () => {
    expect(integrationRolloutBySlug.breathe.state).toBe("live");
    expect(integrationRolloutBySlug["caremetric-intel"].state).toBe("live");
    expect(integrationRolloutBySlug.carebase.state).toBe("in_progress");
  });
});
