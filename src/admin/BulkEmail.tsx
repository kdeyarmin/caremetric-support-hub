import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Product } from '../domain';
import { config } from '../lib/config';
import {
  bulkEmailClient, directorySlugs, maxBody, maxSubject, plainBody, sameSelection, selectionOf, statusLabels, valueLabel,
  type BulkEmailClient, type Campaign, type CampaignSummary, type EmailSource, type Selection,
} from './bulkEmailClient';
import './bulkEmail.css';

const number = new Intl.NumberFormat('en-US');
const when = (value: string) => new Date(value).toLocaleString();
const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
/** "A", "A or B", "A, B or C", as the footer the server adds lists them (server/bulk-email.mjs applicationList). */
const listApplications = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;

export function BulkEmail({products,client=bulkEmailClient,demo=config.demoMode,pollMs=5000}:{products:Product[];client?:BulkEmailClient;demo?:boolean;pollMs?:number}) {
  const apps=products.filter(product=>(directorySlugs as readonly string[]).includes(product.slug)&&product.status!=='retired');
  const [history,setHistory]=useState<CampaignSummary[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  const [choosing,setChoosing]=useState(false);
  const [open,setOpen]=useState<{id:string;initial?:Campaign}|null>(null);
  useEffect(()=>{
    if(demo) return;
    const controller=new AbortController();
    client.list(controller.signal).then(data=>{if(!controller.signal.aborted){setHistory(data.campaigns);setLoading(false);setError('');}})
      .catch(()=>{if(!controller.signal.aborted){setHistory([]);setLoading(false);setError('Emails could not be loaded. Check your administrator sign-in and refresh.');}});
    return ()=>controller.abort();
  },[client,demo,revision]);
  const refresh=()=>{setLoading(true);setError('');setRevision(value=>value+1);};
  return <>
    <div className="page-heading"><div><span className="eyebrow">Super admin</span><h1>Bulk email</h1><p>Email the users of each application, narrowed by their role and account status.</p></div>
      <div className="bulk-actions"><button className="button button-secondary" disabled={demo||loading} onClick={refresh}>Refresh</button><button className="button button-primary" disabled={demo||loading||!!error||choosing||!!open} onClick={()=>setChoosing(true)}>New email</button></div>
    </div>
    <p className="bulk-note">Recipients come from each application's own user directory, read through your administrator session. Every email ends with why the person received it and a one-click unsubscribe link; unsubscribed addresses are never emailed again. Support replies are not affected. Never include patient information.</p>
    {demo ? <section className="panel"><p>Sign in to the live Hub as a platform administrator to email application users. Demo mode does not contain your users.</p></section> : <>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading emails…</p>}
      {choosing && <ChooseApplications apps={apps} client={client} onCancel={()=>setChoosing(false)} onCreated={campaign=>{setChoosing(false);setOpen({id:campaign.id,initial:campaign});}} />}
      {open && <CampaignEditor key={open.id} id={open.id} initial={open.initial} client={client} pollMs={pollMs} onClose={()=>{setOpen(null);refresh();}} />}
      {!loading&&!error&&<section className="panel bulk-history" aria-labelledby="bulk-history-title">
        <h2 id="bulk-history-title">Emails</h2>
        {!history.length ? <p>No emails yet. Choose New email to write one.</p> : <ul>{history.map(item=><li key={item.id}>
          <div><strong>{item.subject||'Untitled draft'}</strong><span>{item.applications.join(', ')}</span></div>
          <span className={'bulk-chip bulk-chip-'+item.status}>{statusLabels[item.status]}</span>
          <span>{item.queuedAt ? `${number.format(item.recipientCount)} recipients · ${number.format(item.delivery.sent)} sent${item.delivery.failed?` · ${number.format(item.delivery.failed)} failed`:''}${item.delivery.unknown?` · ${number.format(item.delivery.unknown)} unconfirmed`:''}${item.unsubscribed?` · ${number.format(item.unsubscribed)} unsubscribed`:''}` : 'Not sent'}</span>
          <span>{when(item.queuedAt??item.createdAt)}</span>
          <button className="button button-secondary button-small" disabled={!!open||choosing} onClick={()=>setOpen({id:item.id})} aria-label={'Open '+(item.subject||'untitled draft')}>Open</button>
        </li>)}</ul>}
      </section>}
    </>}
  </>;
}

function ChooseApplications({apps,client,onCancel,onCreated}:{apps:Product[];client:BulkEmailClient;onCancel:()=>void;onCreated:(campaign:Campaign)=>void}) {
  const [chosen,setChosen]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const submit=async(event:FormEvent)=>{
    event.preventDefault(); if(busy) return;
    if(!chosen.length){setError('Choose at least one application.');return;}
    setBusy(true);setError('');
    try{onCreated(await client.create(chosen));}catch(failure){setError(message(failure,'The email could not be started. Refresh and try again.'));}finally{setBusy(false);}
  };
  return <section className="panel bulk-panel" aria-labelledby="bulk-choose-title"><h2 id="bulk-choose-title">Who should receive it?</h2>
    <p>Choose the applications whose users you want to email. Next, the Hub reads each one's user directory so you can narrow it by role and account status.</p>
    <form onSubmit={event=>void submit(event)}><fieldset className="bulk-apps" disabled={busy}><legend>Applications</legend>
      {apps.map(app=><label key={app.id}><input type="checkbox" checked={chosen.includes(app.id)} onChange={event=>setChosen(current=>event.target.checked?[...current,app.id]:current.filter(id=>id!==app.id))} /> {app.name}</label>)}
    </fieldset>
    <p className="bulk-hint">Healthcare Advisors has consultation contacts rather than application users, so it is not listed.</p>
    {error&&<p role="alert">{error}</p>}
    <div className="bulk-actions"><button type="submit" className="button button-primary" disabled={busy}>{busy?'Starting…':'Read users'}</button><button type="button" className="button button-secondary" disabled={busy} onClick={onCancel}>Cancel</button></div></form>
  </section>;
}

function CampaignEditor({id,initial,client,pollMs,onClose}:{id:string;initial?:Campaign;client:BulkEmailClient;pollMs:number;onClose:()=>void}) {
  const [campaign,setCampaign]=useState<Campaign|null>(initial??null);
  const [error,setError]=useState('');
  const [loadError,setLoadError]=useState('');
  const [retry,setRetry]=useState(0);
  const [subject,setSubject]=useState(initial?.subject??'');
  const [body,setBody]=useState(initial?.body??'');
  const [selection,setSelection]=useState<Selection>(initial?selectionOf(initial):{});
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [testTo,setTestTo]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const [confirmCancel,setConfirmCancel]=useState(false);
  // Bumped whenever a newer campaign state arrives, so a slower status refresh never overwrites it.
  const generation=useRef(0);
  const adopt=(next:Campaign)=>{generation.current++;setCampaign(next);setSubject(next.subject);setBody(next.body);setSelection(selectionOf(next));setConfirmed(false);};
  useEffect(()=>{
    if(initial) return;
    const controller=new AbortController();
    client.get(id,controller.signal).then(next=>{if(!controller.signal.aborted)adopt(next);}).catch(failure=>{if(!controller.signal.aborted)setError(message(failure,'This email could not be loaded.'));});
    return ()=>controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[client,id]);
  const status=campaign?.status;
  // Read directory pages until every application is loaded, ten pages per request.
  useEffect(()=>{
    if(status!=='loading') return;
    const controller=new AbortController();
    void (async()=>{
      try{
        for(;;){
          const next=await client.load(id,controller.signal);
          if(controller.signal.aborted) return;
          if(next.status!=='loading'){adopt(next);return;}
          setCampaign(next);
        }
      }catch(failure){if(!controller.signal.aborted)setLoadError(message(failure,'Reading users stopped.'));}
    })();
    return ()=>controller.abort();
  },[client,id,status,retry]);
  // Follow delivery while sending.
  useEffect(()=>{
    if(status!=='sending') return;
    const controller=new AbortController();
    const timer=setInterval(()=>{const seen=generation.current;client.get(id,controller.signal).then(next=>{if(!controller.signal.aborted&&generation.current===seen)setCampaign(next);}).catch(()=>{});},pollMs);
    return ()=>{clearInterval(timer);controller.abort();};
  },[client,id,status,pollMs]);
  if(!campaign) return <section className="panel bulk-panel" aria-label="Email">{error?<p role="alert">{error}</p>:<p role="status">Loading email…</p>}<div className="bulk-actions"><button className="button button-secondary" onClick={onClose}>Close</button></div></section>;
  const dirty=campaign.status==='ready'&&(subject!==campaign.subject||body!==campaign.body||!sameSelection(selection,selectionOf(campaign)));
  const recipients=campaign.audience?.recipients??0;
  const act=async(name:string,work:()=>Promise<void>)=>{if(busy)return;setBusy(name);setError('');setNotice('');try{await work();}catch(failure){setError(message(failure,'The action could not be completed.'));}finally{setBusy('');}};
  const save=()=>act('save',async()=>{
    if(subject.length>maxSubject||/[\r\n]/.test(subject)) throw new Error(`Write a subject of up to ${maxSubject} characters on one line.`);
    if(body.length>maxBody||!plainBody(body)) throw new Error('Write a plain-text message of up to 20,000 characters.');
    adopt(await client.save(campaign,subject,body,selection));setNotice('Draft saved. The recipient count is up to date.');
  });
  const choose=(productId:string,kind:'roles'|'statuses',values:string[])=>setSelection(current=>({...current,[productId]:{...current[productId],[kind]:values}}));
  return <section className="panel bulk-panel" aria-labelledby="bulk-editor-title">
    <div className="bulk-editor-heading"><div><h2 id="bulk-editor-title">{campaign.subject||'New email'}</h2><span className={'bulk-chip bulk-chip-'+campaign.status}>{statusLabels[campaign.status]}</span></div>
      <div className="bulk-actions">
        {['loading','ready','sending'].includes(campaign.status)&&(confirmCancel
          ? <><span>{campaign.status==='sending'?'Stop the messages not yet sent?':'Discard this draft and its audience?'}</span><button className="button button-secondary button-small" disabled={!!busy} onClick={()=>void act('cancel',async()=>{adopt(await client.cancel(campaign));setConfirmCancel(false);})}>{campaign.status==='sending'?'Stop sending':'Discard'}</button><button className="button button-secondary button-small" onClick={()=>setConfirmCancel(false)}>Keep</button></>
          : <button className="button button-secondary button-small" disabled={!!busy} onClick={()=>setConfirmCancel(true)}>{campaign.status==='sending'?'Stop sending…':'Discard draft…'}</button>)}
        <button className="button button-secondary button-small" disabled={!!busy} onClick={onClose}>Close</button>
      </div></div>
    {notice&&<p role="status">{notice}</p>}
    {error&&<p role="alert">{error}</p>}

    {campaign.status==='loading'&&<div className="bulk-loading">
      <p>Reading users from each application through your administrator session. Keep this page open; large directories take a few minutes.</p>
      {campaign.sources.map(source=><div key={source.productId}><span>{source.productName}</span>
        <progress max={source.total??1} value={source.loaded?(source.total??1):source.read} aria-label={source.productName+' users read'} />
        <small>{source.loaded?`${number.format(source.read)} users read`:`${number.format(source.read)} of ${source.total===null?'…':number.format(source.total)} users read`}</small></div>)}
      {loadError&&<><p role="alert">{loadError}</p><button className="button button-secondary" onClick={()=>{setLoadError('');setRetry(value=>value+1);}}>Retry</button></>}
    </div>}

    {campaign.status==='ready'&&<>
      <h3>1. Audience</h3>
      {campaign.sources.map(source=><Source key={source.productId} source={source} choice={selection[source.productId]??{roles:[],statuses:[]}} onChoose={(kind,values)=>choose(source.productId,kind,values)} disabled={!!busy} />)}
      <div className="bulk-audience" aria-live="polite">
        <div><strong>{number.format(recipients)}</strong><span>{recipients===1?'recipient':'recipients'}</span></div>
        <p>{dirty?'Save the draft to update the recipient count.':`${number.format(campaign.audience?.selectedUsers??0)} selected users · ${number.format(campaign.audience?.withoutEmail??0)} without an email address · ${number.format(campaign.audience?.unsubscribed??0)} unsubscribed. People in more than one application get one email.`}</p>
      </div>
      <h3>2. Message</h3>
      <div className="bulk-fields">
        <label>Subject<input maxLength={maxSubject} value={subject} disabled={!!busy} onChange={event=>setSubject(event.target.value.replace(/[\r\n]+/g,' '))} /></label>
        <label>Message (plain text)<textarea rows={10} maxLength={maxBody} value={body} disabled={!!busy} onChange={event=>setBody(event.target.value)} /><small>{number.format(body.length)} of {number.format(maxBody)} characters</small></label>
        <div className="bulk-footer-preview"><span>Added to every email</span><pre>{`--\nYou are receiving this email because you have an account in ${listApplications(campaign.sources.map(source=>source.productName))}.\nUnsubscribe from CareMetric announcements: (personal link)`}</pre></div>
      </div>
      <div className="bulk-actions"><button className="button button-primary" disabled={!!busy||!dirty} onClick={()=>void save()}>{busy==='save'?'Saving…':'Save draft'}</button>{dirty&&<span className="bulk-hint">Unsaved changes</span>}</div>
      <h3>3. Test and send</h3>
      <form className="bulk-test" onSubmit={event=>{event.preventDefault();void act('test',async()=>{const result=await client.test(campaign,testTo.trim());setNotice(result.delivery==='sent'?`Test sent to ${testTo.trim()}.`:result.delivery==='failed'?'SendGrid refused the test. Check the address.':'The test may not have been sent. Check the inbox before retrying.');});}}>
        <label>Send a test to<input type="email" value={testTo} maxLength={320} disabled={!!busy} onChange={event=>setTestTo(event.target.value)} placeholder="you@caremetric.ai" /></label>
        <button type="submit" className="button button-secondary" disabled={!!busy||dirty||!testTo.trim()||!campaign.subject.trim()||!campaign.body.trim()}>{busy==='test'?'Sending…':'Send test'}</button>
      </form>
      <label className="bulk-confirm"><input type="checkbox" checked={confirmed} disabled={!!busy||dirty||!recipients} onChange={event=>setConfirmed(event.target.checked)} /> I reviewed the audience and message. Send {number.format(recipients)} {recipients===1?'email':'emails'} now.</label>
      <div className="bulk-actions"><button className="button button-primary" disabled={!!busy||dirty||!confirmed||!recipients||!campaign.subject.trim()||!campaign.body.trim()}
        onClick={()=>void act('send',async()=>{adopt(await client.send(campaign,recipients));setNotice('Sending started. You can leave this page; delivery continues on the Hub.');})}>{busy==='send'?'Starting…':`Send to ${number.format(recipients)} ${recipients===1?'recipient':'recipients'}`}</button>
        {(!campaign.subject.trim()||!campaign.body.trim())&&<span className="bulk-hint">Save a subject and message first.</span>}</div>
    </>}

    {['sending','sent','cancelled'].includes(campaign.status)&&<Delivery campaign={campaign} />}
  </section>;
}

function Source({source,choice,onChoose,disabled}:{source:EmailSource;choice:{roles:string[];statuses:string[]};onChoose:(kind:'roles'|'statuses',values:string[])=>void;disabled:boolean}) {
  const group=(kind:'roles'|'statuses',title:string,counts:EmailSource['roleCounts'])=>{
    const chosen=choice[kind];
    return <fieldset className="bulk-group" disabled={disabled}><legend>{title}</legend>
      <div className="bulk-group-actions"><button type="button" className="text-link" onClick={()=>onChoose(kind,counts.map(row=>row.value))}>All</button><button type="button" className="text-link" onClick={()=>onChoose(kind,[])}>None</button></div>
      {counts.map(row=><label key={row.value} title={row.value}><input type="checkbox" checked={chosen.includes(row.value)} onChange={event=>onChoose(kind,event.target.checked?[...chosen,row.value]:chosen.filter(value=>value!==row.value))} /> {valueLabel(row.value)}<span>{number.format(row.users)} · {number.format(row.withEmail)} with email</span></label>)}
      {!counts.length&&<p className="bulk-hint">No users.</p>}
    </fieldset>;
  };
  return <div className="bulk-source"><h4>{source.productName}</h4>
    <p>{number.format(source.read)} users read{source.truncated&&source.total!==null?`. Only the first ${number.format(source.read)} of ${number.format(source.total)} users could be read; the rest are not included.`:'.'}</p>
    <div className="bulk-groups">{group('roles','Roles',source.roleCounts)}{group('statuses','Account status',source.statusCounts)}</div>
  </div>;
}

function Delivery({campaign}:{campaign:Campaign}) {
  const {delivery}=campaign;
  const done=delivery.sent+delivery.failed+delivery.unknown+delivery.cancelled;
  return <div className="bulk-delivery">
    <h3>Delivery</h3>
    <progress max={campaign.recipientCount||1} value={done} aria-label="Messages finished" />
    <dl>
      <div><dt>Recipients</dt><dd>{number.format(campaign.recipientCount)}</dd></div>
      <div><dt>Sent</dt><dd>{number.format(delivery.sent)}</dd></div>
      <div><dt>Waiting</dt><dd>{number.format(delivery.queued+delivery.sending)}</dd></div>
      <div><dt>Refused by SendGrid</dt><dd>{number.format(delivery.failed)}</dd></div>
      <div><dt>Unconfirmed (never resent)</dt><dd>{number.format(delivery.unknown)}</dd></div>
      <div><dt>Cancelled</dt><dd>{number.format(delivery.cancelled)}</dd></div>
      <div><dt>Unsubscribed since</dt><dd>{number.format(campaign.unsubscribed)}</dd></div>
    </dl>
    {campaign.queuedAt&&<p className="bulk-hint">Started {when(campaign.queuedAt)}{campaign.completedAt?` · finished ${when(campaign.completedAt)}`:''}</p>}
    <h3>Message</h3>
    <p><strong>{campaign.subject}</strong></p>
    {campaign.body ? <pre className="bulk-message">{campaign.body}</pre> : <p className="bulk-hint">No message was written.</p>}
  </div>;
}
