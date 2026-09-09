import { describe, expect, it } from "vitest";
import type { ActorContext, Product } from "../domain";
import { caseTargetByKey, eligibleCaseTargets, preferredCaseTarget } from "./caseTargets";

const products: Product[] = [
  {
    id: "product-a",
    slug: "product-a",
    name: "Product A",
    description: "",
    status: "active",
    color: "#000000",
  },
  {
    id: "product-b",
    slug: "product-b",
    name: "Product B",
    description: "",
    status: "pilot",
    color: "#000000",
  },
  {
    id: "product-retired",
    slug: "product-retired",
    name: "Retired product",
    description: "",
    status: "retired",
    color: "#000000",
  },
];

const actor: ActorContext = {
  id: "customer",
  name: "Customer",
  role: "tenant_admin",
  tenantId: "tenant-a",
  tenantName: "Tenant A",
  memberships: [
    { tenantId: "tenant-a", tenantName: "Tenant A", productId: "product-a", role: "customer", intakeEnabled: true },
    { tenantId: "tenant-b", tenantName: "Tenant B", productId: "product-b", role: "tenant_admin", intakeEnabled: true },
    { tenantId: "tenant-a", tenantName: "Tenant A", productId: "product-retired", role: "customer", intakeEnabled: true },
  ],
};

describe("eligible case targets", () => {
  it("returns exact tenant/product entitlement pairs without synthesizing cross-pairs", () => {
    expect(eligibleCaseTargets(actor, products).map(({ tenantId, productId }) => ({ tenantId, productId })))
      .toEqual([
        { tenantId: "tenant-a", productId: "product-a" },
        { tenantId: "tenant-b", productId: "product-b" },
      ]);
  });

  it("does not expose missing, retired, or duplicate product entitlements", () => {
    const targets = eligibleCaseTargets({
      ...actor,
      memberships: [
        ...actor.memberships,
        actor.memberships[0]!,
        { tenantId: "tenant-c", tenantName: "Tenant C", productId: "missing", role: "customer", intakeEnabled: true },
        { tenantId: "tenant-c", tenantName: "Tenant C", productId: "product-b", role: "customer", intakeEnabled: false },
      ],
    }, products);

    expect(targets.map((target) => target.key)).toEqual([
      "tenant-a:product-a",
      "tenant-b:product-b",
    ]);
  });

  it("selects a preferred product only from an exact eligible pair", () => {
    const targets = eligibleCaseTargets(actor, products);

    expect(preferredCaseTarget(targets, "product-b")?.key).toBe("tenant-b:product-b");
    expect(preferredCaseTarget(targets, "missing")).toBeUndefined();
    expect(preferredCaseTarget(targets)).toBeUndefined();
    expect(preferredCaseTarget([targets[0]!])?.key).toBe("tenant-a:product-a");
    expect(preferredCaseTarget([
      targets[0]!,
      { ...targets[0]!, key: "tenant-b:product-a", tenantId: "tenant-b" },
    ], "product-a")).toBeUndefined();
  });

  it("resolves a selection to the matching tenant and product together", () => {
    const targets = eligibleCaseTargets(actor, products);

    expect(caseTargetByKey(targets, "tenant-b:product-b")).toMatchObject({
      tenantId: "tenant-b",
      productId: "product-b",
    });
    expect(caseTargetByKey(targets, "tenant-a:product-b")).toBeUndefined();
  });
});
