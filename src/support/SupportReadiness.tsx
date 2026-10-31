import { isCentralHubApp } from '../hubScope';
import { useCallback, useEffect, useState } from 'react';
import { config } from '../lib/config';
import { readinessClient, intakeBlocker } from './readiness';
import type { IntakeTenant, ReadinessClient, ReadinessProduct } from './readiness';
import './readiness.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Support readiness could not be loaded.';

export function SupportReadiness({ client=readinessClient, demo=config.demoMode }: {client?:ReadinessClient;demo?:boolean}) {
  const [data,setData]=useState<Awaited<ReturnType<ReadinessClient['summary']>>|null>(null);
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  const [selected,setSelected]=useState<string|null>(null);
  useEffect(()=>{
    if(demo) return;
    const controller=new AbortController();
    client.summary(controller.signal).then(value=>{if(!controller.signal.aborted){setData(value);setError('');}})
      .catch(caught=>{if(!controller.signal.aborted) setError(errorText(caught));});
    return ()=>controller.abort();
  },[client,demo,revision]);
  const refresh=useCallback(()=>setRevision(value=>value+1),[]);
  const product=data?.products.find(item=>item.id===selected);
  return <section className="panel support-readiness" aria-label="Customer support readiness">
    <div className="panel-heading"><div><h2>Customer support readiness</h2><p>Published guidance, customer access, and case intake are measured separately for each app.</p></div><button className="button button-secondary button-small" onClick={refresh} disabled={demo}>Refresh readiness</button></div>
    <div className="panel-body">{demo ? <p>Connect to the live Hub to inspect customer access. Demo data does not establish support readiness.</p> : <>
      {error && <p role="alert">{error} Refresh before changing customer intake.</p>}
      {!data && !error && <p role="status">Loading support readiness…</p>}
      {data && <><p className="support-readiness-note">A ready customer has active app access, a verified SMS member, enabled intake, and an active support owner. This does not certify the app's administrator connection or email delivery.</p>
        <div className="support-readiness-table"><table><thead><tr><th>Application</th><th>Published items</th><th>Active customers</th><th>SMS members</th><th>Ready customers</th><th>Intake setup</th></tr></thead><tbody>
          {data.products.filter(item => isCentralHubApp(item.slug)).map(item=><tr key={item.id}><th scope="row">{item.name}</th><td>{item.publishedItemCount}</td><td>{item.activeTenantCount}</td><td>{item.usableMemberCount}</td><td>{item.readyTenantCount}</td><td><button className="button button-secondary button-small" aria-label={`Review ${item.name} customer intake`} aria-pressed={selected===item.id} onClick={()=>setSelected(item.id)}>Review access</button></td></tr>)}
        </tbody></table></div><small>Loaded {new Date(data.loadedAt).toLocaleString()}. Published items include all approved access levels.</small>
        {product && <TenantIntake key={`${product.id}:${revision}`} product={product} client={client} onChanged={refresh} />}
      </>}
    </>}</div>
  </section>;
}

function TenantIntake({product,client,onChanged}:{product:ReadinessProduct;client:ReadinessClient;onChanged:()=>void}) {
  const [offset,setOffset]=useState(0);
  const [data,setData]=useState<Awaited<ReturnType<ReadinessClient['tenants']>>|null>(null);
  const [error,setError]=useState('');
  const [review,setReview]=useState<IntakeTenant|null>(null);
  const [confirmed,setConfirmed]=useState(false);
  const [saving,setSaving]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    client.tenants(product.id,offset,controller.signal).then(value=>{if(!controller.signal.aborted){setData(value);setError('');}})
      .catch(caught=>{if(!controller.signal.aborted) setError(errorText(caught));});
    return ()=>controller.abort();
  },[client,product.id,offset]);
  const change=async()=>{
    if(!review || !confirmed || saving) return;
    setSaving(true);setError('');
    try {await client.set(product.id,review,!review.enabled);onChanged();}
    catch(caught){setError(`${errorText(caught)} Refresh readiness and review current access before trying again.`);setReview(null);setConfirmed(false);}
    finally{setSaving(false);}
  };
  const pageTo=(value:number)=>{setData(null);setReview(null);setConfirmed(false);setOffset(value);};
  return <div className="support-intake-detail"><h3>{product.name} customer intake</h3>
    <p>This screen uses existing product memberships. New customer access must be verified and provisioned before intake can be enabled.</p>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading customer access…</p>}
    {data && <>{!data.rows.length ? <p>No customer access is configured for this app. Complete customer onboarding first.</p> : <>
      <div className="support-readiness-table"><table><thead><tr><th>Customer</th><th>SMS members</th><th>Intake</th><th>Action</th></tr></thead><tbody>
        {data.rows.map(tenant=>{const blocker=intakeBlocker(product,tenant);return <tr key={tenant.tenantId}><th scope="row">{tenant.name}<small>{tenant.tenantId}</small></th><td>{tenant.usableMemberCount}</td><td>{tenant.ready?'Ready':tenant.enabled?'Enabled · access blocked':'Disabled'}{blocker && <small>{blocker}</small>}</td><td><button className="button button-secondary button-small" disabled={saving || (!tenant.enabled && !!blocker)} onClick={()=>{setReview(tenant);setConfirmed(false);}}>{tenant.enabled?'Disable intake':'Enable intake'}</button></td></tr>;})}
      </tbody></table></div>
      <div className="support-intake-pagination"><button className="button button-secondary button-small" disabled={!offset || saving} onClick={()=>pageTo(Math.max(0,offset-data.limit))}>Previous customers</button><span>{offset+1}–{offset+data.rows.length} of {data.total}</span><button className="button button-secondary button-small" disabled={offset+data.rows.length>=data.total || saving} onClick={()=>pageTo(offset+data.limit)}>Next customers</button></div>
    </>}
    {review && <div className="support-intake-review"><h4>{review.enabled?'Disable':'Enable'} intake for {review.name}</h4><p>This applies only to {product.name}. {review.enabled?'Existing case records remain available under their current access rules.':'Existing eligible members will be able to create support cases.'}</p><label><input type="checkbox" checked={confirmed} disabled={saving} onChange={event=>setConfirmed(event.target.checked)} />I reviewed this customer and product access and authorize this intake change.</label><div><button className="button button-primary" disabled={!confirmed || saving} onClick={()=>void change()}>{saving?'Saving…':'Apply intake change'}</button><button className="button button-secondary" disabled={saving} onClick={()=>setReview(null)}>Cancel</button></div></div>}
    </>}
  </div>;
}
