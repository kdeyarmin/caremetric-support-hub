import type { ActorContext, ActorMembership, Product } from "../domain";

export interface CaseTarget extends ActorMembership {
  key: string;
  product: Product;
}

export function caseTargetKey(target: Pick<ActorMembership, "tenantId" | "productId">): string {
  return `${target.tenantId}:${target.productId}`;
}

export function eligibleCaseTargets(actor: ActorContext, products: readonly Product[]): CaseTarget[] {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const seen = new Set<string>();

  return actor.memberships.flatMap((membership) => {
    const product = productsById.get(membership.productId);
    const key = caseTargetKey(membership);
    if (!membership.intakeEnabled || !product || product.status === "retired" || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ ...membership, key, product }];
  });
}

export function preferredCaseTarget(
  targets: readonly CaseTarget[],
  preferredProductId?: string,
): CaseTarget | undefined {
  if (preferredProductId !== undefined) {
    const matches = targets.filter((target) => target.productId === preferredProductId);
    return matches.length === 1 ? matches[0] : undefined;
  }
  return targets.length === 1 ? targets[0] : undefined;
}

export function caseTargetByKey(
  targets: readonly CaseTarget[],
  key: string,
): CaseTarget | undefined {
  return targets.find((target) => target.key === key);
}
