import { describe, expect, it } from "vitest";
import { CAREMETRIC_PRODUCT_SLUGS } from "../../packages/help-sdk/src/index";
import { integrationRolloutBySlug } from "./integrationRollout";

describe("application integration rollout registry", () => {
  it("uses stable product slugs rather than array positions", () => {
    // Every SDK product has a rollout entry; Advisors is a website that links to Help without the SDK.
    expect(Object.keys(integrationRolloutBySlug).sort()).toEqual([...CAREMETRIC_PRODUCT_SLUGS, "advisors"].sort());
  });

  it("distinguishes live deployments from source-only work", () => {
    expect(integrationRolloutBySlug.breathe.state).toBe("live");
    expect(integrationRolloutBySlug["caremetric-emr"].state).toBe("live");
    expect(integrationRolloutBySlug.pennsync.state).toBe("in_progress");
    expect(integrationRolloutBySlug["caremetric-go"].state).toBe("source_ready");
    expect(integrationRolloutBySlug["caremetric-intel"].state).toBe("source_ready");
    expect(integrationRolloutBySlug.carebase.state).toBe("in_progress");
    expect(integrationRolloutBySlug.advisors.state).toBe("source_ready");
  });
});
