import {describe,it,expect} from 'vitest';
import {planOpportunity,qualify} from './policy.mjs';
const now=new Date('2026-11-03T12:00:00Z');
const days=n=>new Date(now.getTime()+n*86400000).toISOString();
const base={id:'x',product:'carebase',internal:false,stage:'trial',owner_agent:'account_manager',created_at:days(-3),next_at:days(-1),trial_end:days(2),events:[],work:[]};
describe('growth lifecycle decisions',()=>{
 it('prioritizes only CareBase and Intel and excludes internal/closed accounts',()=>{
  for(const over of [{product:'breathe'},{internal:true},{stage:'lost'},{stage:'churned'}])expect(planOpportunity({...base,...over},now)).toEqual([]);
 });
 it('gives new trials onboarding, activation and deadline work with outcome criteria',()=>{
  const tasks=planOpportunity(base,now);expect(tasks.map(t=>t.kind)).toEqual(['onboarding','activation','trial']);expect(tasks.every(t=>t.owner==='account_manager'&&t.success)).toBe(true);
 });
 it('does not confuse a missing telemetry feed with inactivity',()=>{
  const paying={...base,stage:'paying',activated_at:days(-20)};
  expect(planOpportunity(paying,now).map(t=>t.kind)).toEqual(['telemetry']);
  expect(planOpportunity({...paying,events:[{kind:'heartbeat',occurred_at:days(0)},{kind:'active',occurred_at:days(-10)}]},now).map(t=>t.kind)).toEqual(['adoption']);
 });
 it('stops the sales sequence on any response or trial conversion',()=>{
  const prospect={...base,stage:'qualified',owner_agent:'marketing_manager',touches:0};
  expect(planOpportunity(prospect,now).map(t=>t.kind)).toEqual(['outreach']);
  for(const kind of ['reply','not_now','negative_reply','positive_reply','meeting_booked','trial_started'])expect(planOpportunity({...prospect,events:[{kind,occurred_at:days(0)}]},now)).toEqual([]);
  expect(planOpportunity({...prospect,touches:3},now)).toEqual([]);
 });
 it('never upsells while support or cancellation is unresolved',()=>{
  const o={...base,stage:'paying',activated_at:days(-5),events:[{kind:'active',occurred_at:days(0)},{kind:'expansion_interest',occurred_at:days(0)},{kind:'support_blocked',occurred_at:days(-1)}]};
  expect(planOpportunity(o,now).map(t=>t.kind)).toEqual(['support']);
 });
 it('rejects stale evidence instead of manufacturing confidence',()=>{
  expect(qualify([{source_url:'https://example.org',confidence:'high',observed_at:days(-90)}],now)).toMatchObject({canDraft:false,fitConfidence:'unknown'});
 });
});

it('starts activation timing at signup and keeps an expired trial actionable',()=>{
 const recent={...base,created_at:days(-100),events:[{kind:'trial_started',occurred_at:days(-1)}]};
 expect(planOpportunity(recent,now).some(w=>w.kind==='activation')).toBe(false);
 expect(planOpportunity({...base,trial_end:days(-1)},now).some(w=>w.key.endsWith(':expired'))).toBe(true);
});
describe('one re-ask and stops',()=>{
 const prospect={...base,product:'caremetric-intel',stage:'qualified',owner_agent:'marketing_manager',trial_end:null,policy:{max_touches:3}};
 it('a sign-up stops outreach like a trial',()=>{
  expect(planOpportunity({...prospect,touches:1},now).map(t=>t.kind)).toEqual(['outreach']);
  expect(planOpportunity({...prospect,touches:1,events:[{kind:'signup',occurred_at:days(-1)}]},now)).toEqual([]);
 });
 it('a re-ask is one message counted from when it began; an old not-now no longer stops it, a no always does',()=>{
  const reask={...prospect,touches:3,verified_at:days(-2),memory:{reengagedAt:days(-1),touchesBefore:3,reengageReason:'not_now'},events:[{kind:'not_now',occurred_at:days(-100)}]};
  expect(planOpportunity(reask,now).map(t=>[t.kind,t.key])).toEqual([['outreach','outreach:3']]);
  expect(planOpportunity({...reask,touches:4},now)).toEqual([]);
  expect(planOpportunity({...reask,events:[...reask.events,{kind:'reply',occurred_at:days(0)}]},now)).toEqual([]);
  expect(planOpportunity({...reask,events:[{kind:'negative_reply',occurred_at:days(-200)}]},now)).toEqual([]);
 });
 it('a re-ask waits until its address was verified in the last 80 days, so the claim cannot cancel it for good',()=>{
  const reask={...prospect,touches:3,memory:{reengagedAt:days(-1),touchesBefore:3,reengageReason:'silent'}};
  expect(planOpportunity({...reask,verified_at:days(-120)},now)).toEqual([]);
  expect(planOpportunity({...reask,verified_at:null},now)).toEqual([]);
  expect(planOpportunity({...reask,verified_at:days(-81)},now)).toEqual([]);
  expect(planOpportunity({...reask,verified_at:days(-79)},now).map(t=>t.kind)).toEqual(['outreach']);
  // Ordinary outreach is unchanged: the claim alone judges its contact.
  expect(planOpportunity({...prospect,touches:1,verified_at:days(-120)},now).map(t=>t.kind)).toEqual(['outreach']);
 });
});
