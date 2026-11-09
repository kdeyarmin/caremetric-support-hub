/**
 * Carries out the Creative Director's approved actions. Each runs once (the database hands an approved action to one caller) and needs
 * no owner session. Neither publishes anything: the side effect is the asset's state, which decides what the Social Media Manager may use.
 *
 * - creative.asset and creative.asset_review: hand an approved asset to the Social Media Manager (`private.creative_handoff`: the asset
 *   becomes `approved` and gets the public name Meta and LinkedIn fetch it by). The database checks that this is the execution it started
 *   for this action, and that an asset approved automatically passed every check with no warning while the owner trusts the agent with
 *   approvals; an asset with a warning is never automatic (the database refuses to record one).
 * - creative.retire: take a tired asset out of use (`private.creative_retire`).
 *
 * The executor does nothing the database has not confirmed: a refusal comes back as a code the Team screen explains.
 */
const failure = code => Object.assign(new Error('The creative action was not carried out.'), { code });
const codes = new Set(['not_executing', 'asset_missing', 'asset_changed', 'approval_required']);

export function creativeExecutors({ store }) {
  const handOver = async execution => {
    if (execution.targetKind !== 'creative_asset' || execution.input?.assetId !== execution.targetId) throw failure('invalid_creative_action');
    // An asset with a warning is the owner's decision alone.
    if (execution.kind === 'creative.asset_review' && execution.autoApproved) throw failure('auto_approved_refused');
    const result = await store.creativeHandoff(execution.id, execution.execution ?? null);
    if (!result?.handedOver) throw failure(codes.has(result?.reason) ? result.reason : 'creative_refused');
    return { handedOver: true, assetId: result.assetId, already: result.already === true };
  };
  return {
    'creative.asset': handOver,
    'creative.asset_review': handOver,
    'creative.retire': async execution => {
      if (execution.targetKind !== 'creative_asset' || execution.input?.assetId !== execution.targetId) throw failure('invalid_creative_action');
      const result = await store.creativeRetire(execution.id, execution.execution ?? null);
      if (!result?.retired) throw failure(codes.has(result?.reason) ? result.reason : 'creative_refused');
      return { retired: true, assetId: result.assetId, already: result.already === true };
    },
  };
}
