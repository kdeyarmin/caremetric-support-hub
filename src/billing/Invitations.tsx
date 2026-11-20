import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Eye, Send } from 'lucide-react';
import { prepareMutationRequest, type PendingMutationRequest } from '../security/mutationRequestKey';
import { type BillingWorkspace as Workspace, dateLabel } from './billingModel';
import { invitablePrices } from './invitationPrices';
import { Notice, StatusChip } from './BillingUi';
import { invitationClient, type InvitationClient } from './invitationClient';
import {
  discountLabel, invitationAppNames, invitationApps, invitationRecordSchema, invitationStatusLabels, isComplimentary, normalizedRecord, plural,
  quantityLabel, regularPriceLabel, yourPriceLabel, type DiscountDuration, type Invitation, type InvitationApp, type InvitationStatus, type PricedOffer,
} from './invitationProtocol';

const chip: Record<InvitationStatus, string> = { pending: 'open', checkout: 'incomplete', active: 'trialing', claimed: 'active', revoked: 'archived', expired: 'archived' };
const messageOf = (caught: unknown, fallback: string) => {
  const issue = caught && typeof caught === 'object' && 'issues' in caught && Array.isArray(caught.issues) ? caught.issues[0]?.message : null;
  return typeof issue === 'string' ? issue : caught instanceof Error ? caught.message : fallback;
};
const delivered = (delivery: 'sent' | 'failed' | 'unknown' | null, email: string) => delivery === 'sent' ? `Invitation emailed to ${email}.`
  : delivery === 'failed' ? `The email service refused the message to ${email}. Check Settings → Email, then use Resend.`
    : delivery === 'unknown' ? `The email service did not confirm the message to ${email}. Check its activity before using Resend.` : '';

/**
 * Billing → Invite a customer: the owner chooses the application, the customer, a plan price and a discount from 0 to 100%, previews the
 * email in the application's own look and sends it. Below, every invitation with its status, and resend, revoke and link actions.
 */
export function InvitationsTab({ data, client = invitationClient }: { data: Workspace; client?: InvitationClient }) {
  const [app, setApp] = useState<InvitationApp>('carebase');
  const [contactName, setContactName] = useState(''); const [contactEmail, setContactEmail] = useState(''); const [organization, setOrganization] = useState('');
  const [priceId, setPriceId] = useState(''); const [quantity, setQuantity] = useState('1');
  const [discount, setDiscount] = useState('0'); const [duration, setDuration] = useState<DiscountDuration>('forever'); const [months, setMonths] = useState('12');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [invitations, setInvitations] = useState<Invitation[] | null>(null); const [listError, setListError] = useState('');
  const [revision, setRevision] = useState(0);
  const pending = useRef<PendingMutationRequest | null>(null);

  const prices = useMemo(() => invitablePrices(data, app), [data, app]);
  // The chosen price, or the application's first one when none (or another application's) is chosen.
  const chosen = prices.find(option => option.price.id === priceId) ?? prices[0] ?? null;
  const perUnit = chosen?.price.pricing_model === 'per_unit';
  const percent = Number(discount);

  useEffect(() => {
    const controller = new AbortController();
    client.list(controller.signal).then(rows => { if (!controller.signal.aborted) { setInvitations(rows); setListError(''); } })
      .catch(caught => { if (!controller.signal.aborted) setListError(messageOf(caught, 'Invitations could not be loaded.')); });
    return () => controller.abort();
  }, [client, revision]);
  const load = () => setRevision(value => value + 1);

  const record = () => invitationRecordSchema.parse(normalizedRecord({
    app, contact_name: contactName, contact_email: contactEmail, organization_name: organization, price: chosen?.price.id ?? '',
    quantity: perUnit ? Number(quantity) : 1, discount_percent: Number(discount), discount_duration: duration,
    discount_months: duration === 'repeating' ? Number(months) : null, note,
  }));
  const offer: PricedOffer | null = chosen && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? {
    unit_amount: chosen.price.unit_amount ?? 0, currency: chosen.price.currency, interval: chosen.price.interval ?? 'month', interval_count: chosen.price.interval_count ?? 1,
    pricing_model: perUnit ? 'per_unit' : 'flat', unit_label: chosen.product.unit_label, plan_name: chosen.product.name,
    quantity: perUnit ? Math.max(1, Math.floor(Number(quantity)) || 1) : 1, discount_percent: percent,
    discount_duration: percent === 0 ? 'forever' : duration, discount_months: duration === 'repeating' && percent > 0 ? Number(months) || 1 : null,
  } : null;

  async function showPreview() {
    setError(''); setNotice('');
    let invitation;
    try { invitation = record(); } catch (caught) { setError(messageOf(caught, 'Check the invitation.')); return; }
    setBusy(true);
    try { const result = await client.preview(invitation); setPreview({ subject: result.subject, html: result.html }); }
    catch (caught) { setError(messageOf(caught, 'The preview could not be made.')); }
    finally { setBusy(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    setError(''); setNotice('');
    let invitation;
    try { invitation = record(); } catch (caught) { setError(messageOf(caught, 'Check the invitation.')); return; }
    pending.current = prepareMutationRequest(pending.current, [JSON.stringify(invitation)]);
    setBusy(true);
    try {
      const result = await client.create(invitation, pending.current.requestKey);
      pending.current = null;
      setNotice(delivered(result.delivery, result.invitation.contact_email) || `The invitation for ${result.invitation.organization_name} was already sent.`);
      setContactName(''); setContactEmail(''); setOrganization(''); setNote(''); setPreview(null);
      load();
    } catch (caught) { setError(messageOf(caught, 'The invitation could not be confirmed. Send it again to check its result; it will not be duplicated.')); }
    finally { setBusy(false); }
  }
  async function change(action: 'resend' | 'revoke' | 'link', row: Invitation) {
    if (action === 'revoke' && !window.confirm(`Revoke the invitation for ${row.organization_name}? Its link stops working.`)) return;
    if (action === 'link' && !window.confirm(`Connect ${appName(row.app)} account …${row.pending_account_hint} to ${row.organization_name}'s plan? Do this only if you know this sign-up is theirs.`)) return;
    setError(''); setNotice(''); setBusy(true);
    try {
      const result = await client.change(action, row.id, row.version);
      setNotice(action === 'resend' ? delivered(result.delivery, row.contact_email) : action === 'revoke' ? `The invitation for ${row.organization_name} was revoked.`
        : `${row.organization_name}'s ${appName(row.app)} account is connected to its plan.`);
      load();
    } catch (caught) { setError(messageOf(caught, 'The change could not be confirmed. Refresh and try again.')); }
    finally { setBusy(false); }
  }

  return <section className="billing-section" aria-label="Invite a customer">
    <div className="billing-section-head"><div><h2>Invite a customer</h2>
      <p>Choose the application, the customer and the price you authorize, with any discount from 0 to 100%. They receive a welcome email in that application's own look, describing it and their price, with a link to accept and sign up. At 100% they never see Stripe: the plan starts as soon as they accept.</p></div></div>
    <Notice text={notice} error={error} />
    <form className="billing-form invite-form" onSubmit={event => void send(event)} aria-label="New invitation">
      <fieldset><legend>Application</legend>
        <div className="invite-apps" role="radiogroup" aria-label="Application">{invitationApps.map(option => <label key={option} className="invite-app">
          <input type="radio" name="invite-app" value={option} checked={app === option} onChange={() => setApp(option)} />{invitationAppNames[option]}</label>)}</div>
        {/* Intel applies a code only to a new sign-up or an organization still setting up its card. An organization that already
            uses it is linked to its own customer already, so this invitation's Link account can't take it; its price changes there. */}
        {app === 'caremetric-intel' && <p className="billing-muted">CareMetric Intel applies an invitation only to a new sign-up or an organization still setting up its card. If the organization already uses Intel, don't invite it: change its plan, price or discount on its page under Customers, where its Intel account is already connected.</p>}
      </fieldset>
      <div className="billing-form-grid">
        <label>Contact name<input required maxLength={120} autoComplete="off" value={contactName} onChange={event => setContactName(event.target.value)} /></label>
        <label>Contact email<input required type="email" maxLength={320} autoComplete="off" value={contactEmail} onChange={event => setContactEmail(event.target.value)} /></label>
      </div>
      <label>Organization<input required maxLength={180} autoComplete="off" value={organization} onChange={event => setOrganization(event.target.value)} /></label>
      <div className="billing-form-grid">
        <label>Plan and price
          <select required value={chosen?.price.id ?? ''} onChange={event => setPriceId(event.target.value)} disabled={!prices.length}>
            {!prices.length && <option value="">No published {appName(app)} plan price</option>}
            {prices.map(option => <option key={option.price.id} value={option.price.id}>{option.label}</option>)}
          </select>
          {!prices.length && <small>Add a plan and its price for {appName(app)} under Catalog first.</small>}
        </label>
        {perUnit && <label>Number of {plural(chosen?.product.unit_label ?? '', 2)}<input required type="number" min={1} max={10000} step={1} value={quantity} onChange={event => setQuantity(event.target.value)} /></label>}
      </div>
      <fieldset><legend>Discount</legend>
        <div className="invite-discount">
          <input type="range" min={0} max={100} step={1} value={Number.isFinite(percent) ? percent : 0} onChange={event => setDiscount(event.target.value)} aria-label="Discount percent slider" />
          <span className="invite-percent"><label>Percent off<input required type="number" min={0} max={100} step={0.01} value={discount} onChange={event => setDiscount(event.target.value)} /></label><span aria-hidden="true">%</span></span>
        </div>
        {percent > 0 && <div className="billing-form-grid">
          <label>Lasts<select value={duration} onChange={event => setDuration(event.target.value as DiscountDuration)}>
            <option value="forever">For as long as they subscribe</option><option value="repeating">For their first months</option><option value="once">On their first invoice only</option></select></label>
          {duration === 'repeating' && <label>Months<input required type="number" min={1} max={36} step={1} value={months} onChange={event => setMonths(event.target.value)} /></label>}
        </div>}
      </fieldset>
      {offer && <div className={`invite-summary${isComplimentary(offer) ? ' invite-summary-free' : ''}`} aria-live="polite">
        <dl>
          {perUnit && <><dt>Quantity</dt><dd>{quantityLabel(offer)}</dd></>}
          <dt>Regular price</dt><dd>{regularPriceLabel(offer)}</dd>
          <dt>Discount</dt><dd>{discountLabel(offer)}</dd>
          <dt>Their price</dt><dd>{yourPriceLabel(offer)}</dd>
        </dl>
        <p>{isComplimentary(offer) ? (offer.discount_duration === 'forever'
          ? 'Complimentary: they skip Stripe entirely. No checkout and no card; the plan starts when they accept.'
          : 'Complimentary to start: no checkout and no card. When the free period ends, Stripe emails them invoices at the regular price.')
          : 'They pay in Stripe Checkout with this discount already applied, then create their sign-in.'}</p>
      </div>}
      <label>Personal note <small>optional; shown in the email as written</small><textarea maxLength={1000} rows={3} value={note} onChange={event => setNote(event.target.value)} /></label>
      <div className="billing-actions">
        <button type="button" className="button button-secondary" onClick={() => void showPreview()} disabled={busy || !chosen}><Eye size={15} aria-hidden="true" />Preview email</button>
        <button type="submit" className="button button-primary" disabled={busy || !chosen}><Send size={15} aria-hidden="true" />{busy ? 'Working…' : 'Send invitation'}</button>
      </div>
    </form>
    {preview && <div className="invite-preview">
      <div className="billing-card-head"><div><h3>Email preview</h3><p>Subject: {preview.subject}</p></div>
        <button type="button" className="button button-secondary button-small" onClick={() => setPreview(null)}>Close preview</button></div>
      <iframe title="Invitation email preview" sandbox="" srcDoc={preview.html} />
      <p className="billing-muted">Logos load from each application's own site in the delivered email.</p>
    </div>}

    <h3>Invitations</h3>
    <Notice error={listError} />
    {invitations && !invitations.length && <p>No invitations yet.</p>}
    {!!invitations?.length && <div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>Customer</th><th>Application and plan</th><th>Discount</th><th>Status</th><th>Sent</th><th></th></tr></thead><tbody>
      {invitations.map(row => <tr key={row.id}>
        <td><strong>{row.organization_name}</strong><br /><span className="billing-muted">{row.contact_name} · {row.contact_email}</span></td>
        <td>{appName(row.app)}<br /><span className="billing-muted">{row.plan_name}{row.pricing_model === 'per_unit' ? ` × ${row.quantity}` : ''} · {regularPriceLabel(row)}</span></td>
        <td>{discountLabel(row)}</td>
        <td><StatusChip status={chip[row.status]} label={invitationStatusLabels[row.status]} />
          {row.status === 'active' && row.pending_account_hint && <><br /><span className="billing-muted">Signed up without the link: account …{row.pending_account_hint}</span></>}
          {row.status === 'claimed' && row.account_hint && <><br /><span className="billing-muted">Account …{row.account_hint}</span></>}
          {row.email_status && row.email_status !== 'sent' && <><br /><span className="billing-muted">Email {row.email_status === 'failed' ? 'refused' : 'not confirmed'}</span></>}</td>
        <td>{dateLabel(row.email_sent_at ?? row.created_at)}{row.send_count > 1 ? <><br /><span className="billing-muted">{row.send_count} sends</span></> : null}
          {['pending', 'checkout'].includes(row.status) && <><br /><span className="billing-muted">expires {dateLabel(row.expires_at)}</span></>}</td>
        <td><div className="billing-actions">
          {row.status === 'active' && row.pending_account_hint && <button type="button" className="button button-primary button-small" disabled={busy} onClick={() => void change('link', row)}>Link account</button>}
          {['pending', 'checkout', 'active', 'expired'].includes(row.status) && <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void change('resend', row)}>Resend</button>}
          {['pending', 'checkout', 'expired'].includes(row.status) && <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void change('revoke', row)}>Revoke</button>}
        </div></td>
      </tr>)}
    </tbody></table></div>}
  </section>;
}
const appName = (app: InvitationApp) => invitationAppNames[app];
