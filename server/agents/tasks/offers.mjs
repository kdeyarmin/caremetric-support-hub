/**
 * `accounts.offers`: the Account Manager's offers from the owner's menu, every morning at 08:40 Eastern (after the customer emails). It reads
 * the switched-on offers with room left under their monthly cap and the accounts that qualify for them (private.agent_offer_candidates:
 * a live trial of one of the offer's products that ends within the offer's window, on an account that never had the offer), and proposes
 * each one with exactly what it changes as the approval card's text. It uses no model and changes nothing itself: an approved offer is
 * made by its executor (accounts/offers.mjs), which checks everything again in the database first.
 *
 * - At most each offer's remaining monthly room is proposed in a run, and one offer per account (a second one waits for the next run).
 * - An agent in Observe proposes nothing and records what it would have proposed, as counts.
 * - On Act, the database approves an offer on its own only when offer.apply is on the agent's list (the "offers" autonomy step adds it
 *   after its supervised week); the result counts what the database recorded.
 * The task result and the run summary carry counts and offer keys only, never an account name.
 */
import { offerPreview, offersFeature } from '../accounts/offers.mjs';
import { plural, recordRun } from './shared.mjs';

export { offersFeature };
const declared = features => (features instanceof Set ? features.has(offersFeature) : Array.isArray(features) && features.includes(offersFeature));
export const candidateLimit = 50;

/** Which candidates a run proposes: within each offer's remaining room, the soonest trial end first, one offer per account. */
export function chooseOffers(snapshot) {
  const offers = new Map((snapshot?.offers ?? []).map(offer => [offer.key, { ...offer, room: Math.max(0, Number(offer.remaining) || 0) }]));
  const accounts = new Set();
  const chosen = [];
  let deferred = 0;
  for (const candidate of snapshot?.candidates ?? []) {
    const offer = offers.get(candidate.offer);
    if (!offer || offer.room <= 0) { deferred += 1; continue; }
    if (accounts.has(candidate.tenant)) { deferred += 1; continue; }
    accounts.add(candidate.tenant);
    offer.room -= 1;
    chosen.push({ candidate, offer });
  }
  return { chosen, deferred };
}

export function offerHandlers({ store, features = null, log = line => console.warn(line) }) {
  if (!declared(features) || typeof store?.offerCandidates !== 'function') return {};
  const stopped = () => Object.assign(new Error('The run was stopped.'), { code: 'task_timeout', transient: true });

  async function offers(task, { signal } = {}) {
    const snapshot = await store.offerCandidates(candidateLimit);
    const { chosen, deferred } = chooseOffers(snapshot);
    const byOffer = list => Object.fromEntries([...new Set(list.map(entry => entry.offer.key))].sort().map(key => [key, list.filter(entry => entry.offer.key === key).length]));
    const base = { mode: snapshot?.mode ?? null, offers: (snapshot?.offers ?? []).length, qualified: (snapshot?.candidates ?? []).length, deferred, truncated: snapshot?.truncated === true };
    const finish = async (result, summary) => {
      await recordRun({ store, log }, task, { promptVersion: 'offers.1', summary, outcome: 'completed' });
      return { result };
    };
    const tail = `${deferred ? ` ${deferred} more ${deferred === 1 ? 'waits' : 'wait'} for room under a cap or the next run.` : ''}${base.truncated ? ' More accounts qualify than one run reads.' : ''}`;

    if (base.offers === 0) return finish({ ...base, outcome: 'no_offers', proposed: 0 }, 'No offer on your menu is switched on (or none has room left this month), so none was proposed.');
    if (chosen.length === 0) return finish({ ...base, outcome: 'nothing_due', proposed: 0 }, `No account qualifies for an offer today.${tail}`);
    if (task.agent?.autonomy === 'observe') {
      return finish({ ...base, outcome: 'observe_only', proposed: 0, byOffer: byOffer(chosen) },
        `Observe only: ${plural(chosen.length, 'offer')} would be proposed. Nothing was proposed.${tail}`);
    }

    let proposed = 0;
    let autoApproved = 0;
    let alreadyProposed = 0;
    const made = [];
    for (const entry of chosen) {
      if (signal?.aborted) throw stopped();
      const { candidate, offer } = entry;
      let proposal;
      try {
        proposal = await store.proposeAction({
          taskId: task.id, kind: 'offer.apply', targetKind: 'billing_account', targetId: candidate.tenant,
          preview: offerPreview(candidate, offer),
          input: { offer: offer.key, tenant: candidate.tenant, product: candidate.product, subscription: candidate.subscription },
        });
      } catch (error) {
        // The owner switched the agent to Observe while this run was going: propose nothing more.
        if (error?.code === '42501') break;
        throw error;
      }
      if (proposal?.created === false) { alreadyProposed += 1; continue; }
      proposed += 1;
      made.push(entry);
      if (proposal?.status === 'auto_approved') autoApproved += 1;
    }
    const result = { ...base, outcome: 'proposed', proposed, autoApproved, alreadyProposed, byOffer: byOffer(made) };
    return finish(result, proposed === 0
      ? `No new offer was proposed.${tail}`
      : `Proposed ${plural(proposed, 'offer')} from your menu${autoApproved ? `; ${autoApproved} approved on ${autoApproved === 1 ? 'its' : 'their'} own, as you handed offers over` : ' for your approval'}.${tail}`);
  }

  return { 'accounts.offers': offers };
}
