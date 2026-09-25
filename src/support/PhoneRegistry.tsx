import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { config } from '../lib/config';
import { blankPhoneRecord, displayPhone, phoneLabels, phoneRecordSchema, phoneRegistryClient, type PhoneRecord, type PhoneRegistryClient, type PhoneRow } from './phoneRegistryModel';
import './phoneRegistry.css';

export function PhoneRegistry({client=phoneRegistryClient,demo=config.demoMode}:{client?:PhoneRegistryClient;demo?:boolean}) {
  const [rows,setRows]=useState<PhoneRow[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  const [search,setSearch]=useState('');
  const [filter,setFilter]=useState('all');
  const [editor,setEditor]=useState<{previous:PhoneRow|null;record:PhoneRecord}|null>(null);
  const [notice,setNotice]=useState('');
  useEffect(()=>{
    if(demo) return;
    const controller=new AbortController();
    client.list(controller.signal).then(data=>{if(!controller.signal.aborted){setRows(data.rows);setLoading(false);setError('');}})
      .catch(()=>{if(!controller.signal.aborted){setRows([]);setLoading(false);setError('Phone numbers could not be loaded. Check your administrator sign-in and refresh.');}});
    return ()=>controller.abort();
  },[client,demo,revision]);
  const refresh=()=>{setLoading(true);setError('');setRevision(value=>value+1);};
  const query=search.trim().toLowerCase();
  const digits=query.replace(/\D/g,'');
  const shown=rows.filter(row=>(filter==='all'||(filter==='review' ? row.usage_status==='unknown'||row.lifecycle==='unknown'||row.voice_status==='unknown'||row.sms_status==='unknown'||row.sms_status==='pending'||row.sms_status==='rejected' : row.lifecycle===filter))
    && (!query || [row.number,displayPhone(row.number),row.label,row.provider,row.account,row.purpose,row.apps,row.owner,row.notes].some(value=>value.toLowerCase().includes(query)) || (digits.length>=3 && row.number.includes(digits))));
  return <>
    <div className="page-heading"><div><span className="eyebrow">Super admin</span><h1>Phone numbers</h1><p>Keep every business number, its purpose, and the evidence of its use in one place.</p></div>
      <div className="phone-registry-actions"><Link className="button button-secondary" to="/phone">Phone messages</Link><button className="button button-secondary" disabled={demo||loading||!!editor} onClick={refresh}>Refresh</button><button className="button button-primary" disabled={demo||loading||!!error||!!editor} onClick={()=>{setNotice('');setEditor({previous:null,record:{...blankPhoneRecord}});}}>Add number</button></div>
    </div>
    <p className="phone-registry-note">This is a maintained inventory. “Configured” describes routing; “usage observed” requires dated evidence. Unknown usage does not mean a number is unused. Saving a record updates this registry only.</p>
    {demo ? <section className="panel"><p>Sign in to the live Hub as a platform administrator to manage your phone numbers. Demo mode does not contain your number inventory.</p></section> : <>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading phone numbers…</p>}
      {!loading&&!error&&<>
        <div className="phone-registry-counts" aria-label="Inventory summary"><div><strong>{rows.length}</strong><span>Total numbers</span></div><div><strong>{rows.filter(row=>row.lifecycle==='active').length}</strong><span>Marked active</span></div><div><strong>{rows.filter(row=>row.usage_status==='unknown').length}</strong><span>Usage needs review</span></div><div><strong>{rows.filter(row=>row.sms_status==='pending'||row.sms_status==='rejected'||row.sms_status==='unknown').length}</strong><span>Texting needs attention</span></div></div>
        <div className="phone-registry-filters"><label>Search numbers<input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Number, app, provider, purpose…" /></label><label>Show<select value={filter} onChange={event=>setFilter(event.target.value)}><option value="all">All numbers</option><option value="review">Needs review</option>{Object.entries(phoneLabels.lifecycle).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
        {!shown.length && <p>{rows.length?'No numbers match your search.':'No numbers recorded yet. Add a number to begin.'}</p>}
        <div className="phone-registry-list">{shown.map(row=><article className="panel phone-number-card" key={row.id}>
          <div className="phone-number-heading"><div><h2>{displayPhone(row.number)}</h2><strong>{row.label}</strong><p>{row.provider}{row.account?' · '+row.account:''}</p></div><button className="button button-secondary button-small" disabled={!!editor} onClick={()=>{const record=phoneRecordSchema.parse(Object.fromEntries(Object.keys(blankPhoneRecord).map(key=>[key,row[key as keyof PhoneRecord]])));setNotice('');setEditor({previous:row,record});}} aria-label={'Edit '+displayPhone(row.number)}>Edit details</button></div>
          <div className="phone-number-status"><span>{phoneLabels.lifecycle[row.lifecycle]}</span><span>{phoneLabels.usage_status[row.usage_status]}</span><span>Voice: {phoneLabels.voice_status[row.voice_status]}</span><span>Text: {phoneLabels.sms_status[row.sms_status]}</span></div>
          <dl><div><dt>Purpose</dt><dd>{row.purpose}</dd></div><div><dt>Apps / services</dt><dd>{row.apps||'Not recorded'}</dd></div><div><dt>Responsible owner</dt><dd>{row.owner||'Not assigned'}</dd></div><div><dt>Voice routing</dt><dd>{row.voice_routing||'Not recorded'}</dd></div><div><dt>Text routing</dt><dd>{row.sms_routing||'Not recorded'}</dd></div><div><dt>Last known use</dt><dd>{row.last_used_on||'Exact date not recorded'}</dd></div><div><dt>Last reviewed</dt><dd>{row.reviewed_on||'Not reviewed'}</dd></div><div><dt>Usage evidence</dt><dd>{row.evidence||'Not recorded'}</dd></div>{row.notes&&<div><dt>Notes / next action</dt><dd>{row.notes}</dd></div>}</dl>
          <small>Record updated {new Date(row.updated_at).toLocaleString()}</small>
        </article>)}</div>
      </>}
      {editor && <PhoneEditor key={editor.previous?.id??'new'} initial={editor.record} previous={editor.previous} client={client} onCancel={()=>setEditor(null)} onSaved={saved=>{setRows(current=>[...current.filter(row=>row.id!==saved.id),saved].sort((a,b)=>a.number.localeCompare(b.number)));setEditor(null);setNotice('Phone number saved.');}} />}
    </>}
  </>;
}

function PhoneEditor({initial,previous,client,onCancel,onSaved}:{initial:PhoneRecord;previous:PhoneRow|null;client:PhoneRegistryClient;onCancel:()=>void;onSaved:(row:PhoneRow)=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(dialog.current&&!dialog.current.open) dialog.current.showModal();},[]);
  const [record,setRecord]=useState(initial);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const change=(key:keyof PhoneRecord,value:string)=>setRecord(current=>({...current,[key]:value}));
  const save=async(event:FormEvent)=>{
    event.preventDefault(); if(saving) return;
    const parsed=phoneRecordSchema.safeParse(record);
    if(!parsed.success){setError(parsed.error.issues[0]?.message??'Review the form.');return;}
    setSaving(true);setError('');
    try{onSaved(await client.save(parsed.data,previous));}
    catch{setError('The record was not saved. It may already exist or have changed. Cancel and refresh before retrying; your edits remain here.');}
    finally{setSaving(false);}
  };
  const input=(key:keyof PhoneRecord,label:string,maxLength:number,required=false,type='text')=><label key={key}>{label}<input name={key} type={type} maxLength={maxLength} required={required} value={record[key]} disabled={saving||(key==='number'&&!!previous)} onChange={event=>change(key,event.target.value)} {...(key==='number'?{placeholder:'+18775212890',inputMode:'tel' as const}:{})} /></label>;
  return <dialog ref={dialog} className="panel phone-editor" aria-labelledby="phone-editor-title" onCancel={event=>{event.preventDefault();if(!saving)onCancel();}}><h2 id="phone-editor-title">{previous?'Edit phone details':'Add a phone number'}</h2><p>Record business numbers only. Use Retired to keep a number’s history. Routing descriptions do not change your phone provider.</p>
    <form onSubmit={event=>void save(event)}><fieldset disabled={saving}><legend className="sr-only">Phone number details</legend><div className="phone-editor-grid">
      {input('number','Phone number (international format)',16,true)}{input('label','Display name',100,true)}{input('provider','Provider',100,true)}{input('account','Provider account',100)}{input('purpose','Purpose',500,true)}{input('apps','Apps / services',300)}{input('owner','Responsible owner',100)}
      {(Object.keys(phoneLabels) as (keyof typeof phoneLabels)[]).map(key=><label key={key}>{{lifecycle:'Lifecycle',usage_status:'Usage evidence status',voice_status:'Voice status',sms_status:'Text status'}[key]}<select value={record[key]} onChange={event=>change(key,event.target.value)}>{Object.entries(phoneLabels[key]).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>)}
      {input('voice_routing','Voice routing',500)}{input('sms_routing','Text routing',500)}{input('last_used_on','Last known use date',10,false,'date')}{input('reviewed_on','Review date',10,false,'date')}
      <label>Usage evidence<textarea rows={3} maxLength={1000} value={record.evidence} onChange={event=>change('evidence',event.target.value.replace(/[\r\n]+/g,' '))} /></label><label>Notes / next action<textarea rows={3} maxLength={2000} value={record.notes} onChange={event=>change('notes',event.target.value.replace(/[\r\n]+/g,' '))} /></label>
    </div></fieldset>{error&&<p role="alert">{error}</p>}<div className="phone-registry-actions"><button type="submit" className="button button-primary" disabled={saving}>{saving?'Saving…':'Save number'}</button><button type="button" className="button button-secondary" disabled={saving} onClick={onCancel}>Cancel</button></div></form>
  </dialog>;
}
