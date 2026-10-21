import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { config } from '../lib/config';
import {
  centsToDollars, formatCents, intervalLabels, isComplimentaryNow, localToday, newTenantSchema, parseDollars, priceLabel, recordedMonthlyCents, slugify,
  statusLabels, subscriptionRecordSchema, tenantAccountsClient, tenantEditSchema, tenantStatuses,
  type SubscriptionRecord, type TenantAccount, type TenantAccountsClient, type TenantProduct, type TenantStatus, type TenantSubscription,
} from './tenantAccountsModel';
import './tenantAccounts.css';

type Editor = {kind:'create'} | {kind:'tenant';tenant:TenantAccount} | {kind:'subscription';tenant:TenantAccount;subscription:TenantSubscription|null};
type Draft = Omit<SubscriptionRecord,'price_cents'> & {price:string};
const blankDraft: Draft = {access_status:'active',plan_name:'',price:'',billing_interval:'month',complimentary:false,complimentary_reason:'',complimentary_until:'',notes:''};
const filters = {all:'All tenants',active:'Active',suspended:'Suspended',closed:'Closed',complimentary:'Has a complimentary subscription',unpriced:'Pricing not recorded'} as const;
type Filter = keyof typeof filters;

export function TenantAccounts({client=tenantAccountsClient,demo=config.demoMode,today=localToday()}:{client?:TenantAccountsClient;demo?:boolean;today?:string}) {
  const [tenants,setTenants]=useState<TenantAccount[]>([]);
  const [products,setProducts]=useState<TenantProduct[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  const [search,setSearch]=useState('');
  const [filter,setFilter]=useState<Filter>('all');
  const [editor,setEditor]=useState<Editor|null>(null);
  const [notice,setNotice]=useState('');
  useEffect(()=>{
    if(demo) return;
    const controller=new AbortController();
    client.list(controller.signal).then(data=>{if(!controller.signal.aborted){setTenants(data.tenants);setProducts(data.products);setLoading(false);setError('');}})
      .catch(()=>{if(!controller.signal.aborted){setTenants([]);setProducts([]);setLoading(false);setError('Tenants could not be loaded. Check your administrator sign-in and refresh.');}});
    return ()=>controller.abort();
  },[client,demo,revision]);
  const refresh=()=>{setLoading(true);setError('');setNotice('');setRevision(value=>value+1);};
  const saved=(tenant:TenantAccount,message:string)=>{
    setTenants(current=>[...current.filter(item=>item.id!==tenant.id),tenant].sort((a,b)=>a.name.localeCompare(b.name)));
    setEditor(null);setNotice(message);
  };
  const open=(next:Editor)=>{setNotice('');setEditor(next);};
  const query=search.trim().toLowerCase();
  const shown=tenants.filter(tenant=>matchesFilter(tenant,filter,today)
    && (!query || [tenant.name,tenant.slug,tenant.industry,...tenant.subscriptions.flatMap(item=>[item.product_name,item.pricing?.plan_name??''])].some(value=>value.toLowerCase().includes(query))));
  const live=tenants.filter(tenant=>tenant.status==='active').flatMap(tenant=>tenant.subscriptions.filter(item=>item.access_status==='active'&&item.pricing));
  return <>
    <div className="page-heading"><div><span className="eyebrow">Super admin</span><h1>Tenants &amp; subscriptions</h1><p>Set up customer tenants by hand, choose their applications, and set each subscription's price — or make it complimentary.</p></div>
      <div className="tenant-actions"><button className="button button-secondary" disabled={demo||loading||!!editor} onClick={refresh}>Refresh</button><button className="button button-primary" disabled={demo||loading||!!error||!!editor} onClick={()=>open({kind:'create'})}>Set up tenant</button></div>
    </div>
    <p className="tenant-note">Prices here are the Hub's subscription record for each tenant. Saving never charges a card and does not change Stripe or an application's own billing. Tenants created through app onboarding appear here too, so you can record their pricing.</p>
    {demo ? <section className="panel"><p>Sign in to the live Hub as a platform administrator to set up tenants and pricing. Demo mode does not contain your tenants.</p></section> : <>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading tenants…</p>}
      {!loading&&!error&&<>
        <div className="tenant-counts" aria-label="Tenant summary">
          <div><strong>{tenants.length}</strong><span>Tenants · {tenants.filter(tenant=>tenant.status==='active').length} active</span></div>
          <div><strong>{live.filter(item=>!isComplimentaryNow(item.pricing!,today)).length}</strong><span>Paid subscriptions in use</span></div>
          <div><strong>{live.filter(item=>isComplimentaryNow(item.pricing!,today)).length}</strong><span>Complimentary subscriptions</span></div>
          <div><strong>{formatCents(recordedMonthlyCents(tenants,today))}</strong><span>Recorded monthly value (yearly prices ÷ 12)</span></div>
        </div>
        <div className="tenant-filters"><label>Search tenants<input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Name, slug, application, plan…" /></label><label>Show<select value={filter} onChange={event=>setFilter(event.target.value as Filter)}>{Object.entries(filters).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
        {!shown.length && <p>{tenants.length?'No tenants match your search.':'No tenants yet. Set up a tenant to begin.'}</p>}
        <div className="tenant-list">{shown.map(tenant=><article className="panel tenant-card" key={tenant.id}>
          <div className="tenant-card-heading"><div><h2>{tenant.name}</h2><p>{tenant.slug}{tenant.industry?' · '+tenant.industry:''}</p></div>
            <div className="tenant-actions"><button className="button button-secondary button-small" disabled={!!editor} onClick={()=>open({kind:'tenant',tenant})} aria-label={'Edit '+tenant.name}>Edit tenant</button><button className="button button-secondary button-small" disabled={!!editor||!products.some(product=>!tenant.subscriptions.some(item=>item.product_id===product.id))} onClick={()=>open({kind:'subscription',tenant,subscription:null})} aria-label={'Add an application to '+tenant.name}>Add application</button></div></div>
          <div className="tenant-status"><span className={'tenant-chip tenant-chip-'+tenant.status}>{statusLabels[tenant.status]}</span>{tenant.linked&&<span className="tenant-chip">Linked to an app account</span>}<span className="tenant-chip">{tenant.member_count} active {tenant.member_count===1?'member':'members'}</span></div>
          {tenant.subscriptions.length ? <ul className="tenant-subscriptions" aria-label={tenant.name+' applications'}>{tenant.subscriptions.map(item=><li key={item.product_id}>
            <div><strong>{item.product_name}</strong><span className={'tenant-chip tenant-chip-'+item.access_status}>{statusLabels[item.access_status]}</span></div>
            <div><span className="tenant-label">Plan</span>{item.pricing?.plan_name||'Not recorded'}</div>
            <div><span className="tenant-label">Price</span><span className={item.pricing&&isComplimentaryNow(item.pricing,today)?'tenant-free':''}>{priceLabel(item.pricing,today)}</span></div>
            <button className="button button-secondary button-small" disabled={!!editor} onClick={()=>open({kind:'subscription',tenant,subscription:item})} aria-label={(item.pricing?'Edit pricing for ':'Set pricing for ')+item.product_name+' at '+tenant.name}>{item.pricing?'Edit pricing':'Set pricing'}</button>
          </li>)}</ul> : <p>No applications yet. Add one to record its subscription.</p>}
          <small>Created {new Date(tenant.created_at).toLocaleDateString()} · updated {new Date(tenant.updated_at).toLocaleString()}</small>
        </article>)}</div>
      </>}
      {editor?.kind==='create' && <CreateTenantDialog products={products} client={client} today={today} onCancel={()=>setEditor(null)} onSaved={tenant=>saved(tenant,tenant.name+' is set up.')} />}
      {editor?.kind==='tenant' && <TenantDialog tenant={editor.tenant} client={client} onCancel={()=>setEditor(null)} onSaved={tenant=>saved(tenant,'Tenant saved.')} />}
      {editor?.kind==='subscription' && <SubscriptionDialog tenant={editor.tenant} subscription={editor.subscription} products={products} client={client} today={today} onCancel={()=>setEditor(null)} onSaved={tenant=>saved(tenant,'Subscription saved.')} />}
    </>}
  </>;
}

function matchesFilter(tenant:TenantAccount,filter:Filter,today:string) {
  if(filter==='all') return true;
  if(filter==='complimentary') return tenant.subscriptions.some(item=>item.pricing&&isComplimentaryNow(item.pricing,today));
  if(filter==='unpriced') return tenant.subscriptions.some(item=>!item.pricing);
  return tenant.status===filter;
}

function draftFrom(item:TenantSubscription|null):Draft {
  if(!item?.pricing) return {...blankDraft,access_status:item?.access_status??'active'};
  const pricing=item.pricing;
  return {access_status:item.access_status,plan_name:pricing.plan_name,price:pricing.complimentary&&!pricing.price_cents?'':centsToDollars(pricing.price_cents),billing_interval:pricing.billing_interval,
    complimentary:pricing.complimentary,complimentary_reason:pricing.complimentary_reason,complimentary_until:pricing.complimentary_until,notes:pricing.notes};
}

/** The reviewed record, or the first reason it cannot be saved. Free fields are cleared when the subscription is paid. */
function recordFrom(draft:Draft,previousUntil:string,today:string):{record:SubscriptionRecord}|{error:string} {
  const price=draft.price.trim()===''&&draft.complimentary ? 0 : parseDollars(draft.price);
  if(price===null) return {error:draft.price.trim() ? 'Enter a price in dollars, such as 499 or 499.00, up to $1,000,000.' : 'Enter a price, or make the subscription complimentary.'};
  const record={access_status:draft.access_status,plan_name:draft.plan_name,price_cents:price,billing_interval:draft.billing_interval,complimentary:draft.complimentary,
    complimentary_reason:draft.complimentary?draft.complimentary_reason:'',complimentary_until:draft.complimentary?draft.complimentary_until:'',notes:draft.notes};
  if(record.complimentary_until&&record.complimentary_until<today&&record.complimentary_until!==previousUntil) return {error:'Choose a complimentary end date of today or later.'};
  const parsed=subscriptionRecordSchema.safeParse(record);
  return parsed.success ? {record:parsed.data} : {error:parsed.error.issues[0]?.message??'Review the subscription.'};
}

function Dialog({title,intro,saving,onCancel,children}:{title:string;intro:ReactNode;saving:boolean;onCancel:()=>void;children:ReactNode}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(dialog.current&&!dialog.current.open) dialog.current.showModal();},[]);
  return <dialog ref={dialog} className="panel tenant-editor" aria-labelledby="tenant-editor-title" onCancel={event=>{event.preventDefault();if(!saving)onCancel();}}>
    <h2 id="tenant-editor-title">{title}</h2><p>{intro}</p>{children}
  </dialog>;
}

function Actions({saving,label,error,onCancel}:{saving:boolean;label:string;error:string;onCancel:()=>void}) {
  return <>{error&&<p role="alert">{error}</p>}<div className="tenant-actions"><button type="submit" className="button button-primary" disabled={saving}>{saving?'Saving…':label}</button><button type="button" className="button button-secondary" disabled={saving} onClick={onCancel}>Cancel</button></div></>;
}

/** A labelled control with a hint kept outside the label and linked to the control. */
function Hinted({label,hint,children}:{label:string;hint:string;children:(hintId:string)=>ReactNode}) {
  const id=useId();
  return <div className="tenant-field"><label>{label}{children(id)}</label><small id={id}>{hint}</small></div>;
}

function SubscriptionFields({draft,setDraft,previousUntil,today}:{draft:Draft;setDraft:(update:(current:Draft)=>Draft)=>void;previousUntil:string;today:string}) {
  const change=<K extends keyof Draft>(key:K,value:Draft[K])=>setDraft(current=>({...current,[key]:value}));
  return <>
    <div className="tenant-editor-grid">
      <label>Access<select value={draft.access_status} onChange={event=>change('access_status',event.target.value as TenantStatus)}>{tenantStatuses.map(status=><option key={status} value={status}>{statusLabels[status]}</option>)}</select></label>
      <label>Plan name<input maxLength={80} required value={draft.plan_name} onChange={event=>change('plan_name',event.target.value)} placeholder="e.g. Agency, Enterprise, Pilot" /></label>
    </div>
    <fieldset className="tenant-pricing"><legend>Pricing</legend>
      <label className="tenant-radio"><input type="radio" name="pricing" checked={!draft.complimentary} onChange={()=>change('complimentary',false)} /> Paid subscription</label>
      <label className="tenant-radio"><input type="radio" name="pricing" checked={draft.complimentary} onChange={()=>change('complimentary',true)} /> Complimentary (free)</label>
    </fieldset>
    <div className="tenant-editor-grid">
      {draft.complimentary
        ? <Hinted label="Regular price (USD)" hint="Optional unless the complimentary period has an end date; it applies afterward.">{hintId=><span className="tenant-money"><input inputMode="decimal" maxLength={13} aria-describedby={hintId} value={draft.price} onChange={event=>change('price',event.target.value)} placeholder="499.00" /></span>}</Hinted>
        : <label>Price (USD)<span className="tenant-money"><input inputMode="decimal" maxLength={13} required value={draft.price} onChange={event=>change('price',event.target.value)} placeholder="499.00" /></span></label>}
      <label>Billed per<select value={draft.billing_interval} onChange={event=>change('billing_interval',event.target.value as Draft['billing_interval'])}>{Object.entries(intervalLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      {draft.complimentary&&<>
        <label>Why it is complimentary<input maxLength={300} value={draft.complimentary_reason} onChange={event=>change('complimentary_reason',event.target.value)} placeholder="e.g. Launch partner, service credit" /></label>
        <Hinted label="Free until (optional)" hint="Leave blank to keep it free until you change it.">{hintId=><input type="date" aria-describedby={hintId} min={previousUntil&&previousUntil<today?previousUntil:today} value={draft.complimentary_until} onChange={event=>change('complimentary_until',event.target.value)} />}</Hinted>
      </>}
    </div>
    <label className="tenant-wide">Notes<textarea rows={2} maxLength={1000} value={draft.notes} onChange={event=>change('notes',event.target.value.replace(/[\r\n]+/g,' '))} placeholder="Order form, agreed terms or next review" /></label>
  </>;
}

function CreateTenantDialog({products,client,today,onCancel,onSaved}:{products:TenantProduct[];client:TenantAccountsClient;today:string;onCancel:()=>void;onSaved:(tenant:TenantAccount)=>void}) {
  const [name,setName]=useState('');
  const [slug,setSlug]=useState('');
  const [slugEdited,setSlugEdited]=useState(false);
  const [industry,setIndustry]=useState('');
  const [productId,setProductId]=useState(products[0]?.id??'');
  const [draft,setDraft]=useState(blankDraft);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const save=async(event:FormEvent)=>{
    event.preventDefault(); if(saving) return;
    let subscriptions:(SubscriptionRecord&{product_id:string})[]=[];
    if(productId){
      const result=recordFrom(draft,'',today);
      if('error' in result){setError(result.error);return;}
      subscriptions=[{product_id:productId,...result.record}];
    }
    const parsed=newTenantSchema.safeParse({name,slug,industry,subscriptions});
    if(!parsed.success){setError(parsed.error.issues[0]?.message??'Review the form.');return;}
    setSaving(true);setError('');
    try{onSaved(await client.create(parsed.data));}
    catch{setError('The tenant was not created. The slug may already be in use, or your sign-in may need renewing. Your entries remain here; review them and try again.');}
    finally{setSaving(false);}
  };
  return <Dialog title="Set up a tenant" intro="Create the customer tenant and its first application. You can add more applications and change pricing afterward." saving={saving} onCancel={onCancel}>
    <form onSubmit={event=>void save(event)}><fieldset disabled={saving}><legend className="sr-only">Tenant details</legend>
      <div className="tenant-editor-grid">
        <label>Tenant name<input maxLength={180} required value={name} onChange={event=>{setName(event.target.value);if(!slugEdited)setSlug(slugify(event.target.value));}} placeholder="e.g. Keystone Home Health" /></label>
        <Hinted label="Slug" hint="Permanent identifier; it cannot be changed later.">{hintId=><input maxLength={63} required aria-describedby={hintId} value={slug} onChange={event=>{setSlugEdited(true);setSlug(event.target.value.toLowerCase());}} />}</Hinted>
        <label>Industry (optional)<input maxLength={120} value={industry} onChange={event=>setIndustry(event.target.value)} placeholder="e.g. Home health, hospice" /></label>
        <label>First application<select value={productId} onChange={event=>setProductId(event.target.value)}>{products.map(product=><option key={product.id} value={product.id}>{product.name}</option>)}<option value="">Add applications later</option></select></label>
      </div>
      {productId&&<SubscriptionFields draft={draft} setDraft={setDraft} previousUntil="" today={today} />}
    </fieldset><Actions saving={saving} label="Create tenant" error={error} onCancel={onCancel} /></form>
  </Dialog>;
}

function TenantDialog({tenant,client,onCancel,onSaved}:{tenant:TenantAccount;client:TenantAccountsClient;onCancel:()=>void;onSaved:(tenant:TenantAccount)=>void}) {
  const [record,setRecord]=useState({name:tenant.name,industry:tenant.industry,status:tenant.status});
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const save=async(event:FormEvent)=>{
    event.preventDefault(); if(saving) return;
    const parsed=tenantEditSchema.safeParse(record);
    if(!parsed.success){setError(parsed.error.issues[0]?.message??'Review the form.');return;}
    setSaving(true);setError('');
    try{onSaved(await client.saveTenant(tenant,parsed.data));}
    catch{setError('The tenant was not saved. It may have changed since you opened it. Cancel and refresh before retrying; your edits remain here.');}
    finally{setSaving(false);}
  };
  return <Dialog title={'Edit '+tenant.name} intro={<>Slug <strong>{tenant.slug}</strong> stays the same. Support intake works only while a tenant is active.</>} saving={saving} onCancel={onCancel}>
    <form onSubmit={event=>void save(event)}><fieldset disabled={saving}><legend className="sr-only">Tenant details</legend><div className="tenant-editor-grid">
      <label>Tenant name<input maxLength={180} required value={record.name} onChange={event=>setRecord(current=>({...current,name:event.target.value}))} /></label>
      <label>Industry (optional)<input maxLength={120} value={record.industry} onChange={event=>setRecord(current=>({...current,industry:event.target.value}))} /></label>
      <label>Status<select value={record.status} onChange={event=>setRecord(current=>({...current,status:event.target.value as TenantStatus}))}>{tenantStatuses.map(status=><option key={status} value={status}>{statusLabels[status]}</option>)}</select></label>
    </div></fieldset><Actions saving={saving} label="Save tenant" error={error} onCancel={onCancel} /></form>
  </Dialog>;
}

function SubscriptionDialog({tenant,subscription,products,client,today,onCancel,onSaved}:{tenant:TenantAccount;subscription:TenantSubscription|null;products:TenantProduct[];client:TenantAccountsClient;today:string;onCancel:()=>void;onSaved:(tenant:TenantAccount)=>void}) {
  const available=products.filter(product=>!tenant.subscriptions.some(item=>item.product_id===product.id));
  const [productId,setProductId]=useState(subscription?.product_id??available[0]?.id??'');
  const [draft,setDraft]=useState(()=>draftFrom(subscription));
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const previousUntil=subscription?.pricing?.complimentary_until??'';
  const save=async(event:FormEvent)=>{
    event.preventDefault(); if(saving) return;
    if(!productId){setError('Choose an application.');return;}
    const result=recordFrom(draft,previousUntil,today);
    if('error' in result){setError(result.error);return;}
    setSaving(true);setError('');
    try{onSaved(await client.saveSubscription(tenant,productId,result.record,subscription?.pricing??null));}
    catch{setError('The subscription was not saved. It may have changed since you opened it. Cancel and refresh before retrying; your edits remain here.');}
    finally{setSaving(false);}
  };
  const title=subscription ? (subscription.pricing?'Edit pricing':'Set pricing')+' — '+subscription.product_name : 'Add an application';
  return <Dialog title={title} intro={<>For <strong>{tenant.name}</strong>. Saving updates the Hub's subscription record only; it does not charge or refund anyone.</>} saving={saving} onCancel={onCancel}>
    <form onSubmit={event=>void save(event)}><fieldset disabled={saving}><legend className="sr-only">Subscription details</legend>
      {!subscription&&<div className="tenant-editor-grid"><label>Application<select value={productId} onChange={event=>setProductId(event.target.value)}>{available.map(product=><option key={product.id} value={product.id}>{product.name}</option>)}</select></label></div>}
      <SubscriptionFields draft={draft} setDraft={setDraft} previousUntil={previousUntil} today={today} />
    </fieldset><Actions saving={saving} label="Save subscription" error={error} onCancel={onCancel} /></form>
  </Dialog>;
}
