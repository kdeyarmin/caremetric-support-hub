import { describe, expect, it } from "vitest";
import { CAREMETRIC_PRODUCT_SLUGS } from "../../packages/help-sdk/src/index";
import { integrationRolloutBySlug } from "./integrationRollout";

describe("application integration rollout registry", () => {
  it("uses stable product slugs rather than array positions", () => {
    expect(Object.keys(integrationRolloutBySlug).sort()).toEqual([...CAREMETRIC_PRODUCT_SLUGS].sort());
  });

  it("distinguishes live deployments from source-only work", () => {
    expect(integrationRolloutBySlug.breathe.state).toBe("live");
    expect(integrationRolloutBySlug["caremetric-emr"].state).toBe("live");
    expect(integrationRolloutBySlug.pennsync.state).toBe("in_progress");
    expect(integrationRolloutBySlug["caremetric-go"].state).toBe("source_ready");
  });
});
