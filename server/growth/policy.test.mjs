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
it('plans one check-in when the database finds one due, and none otherwise',()=>{
 const prospect={...base,owner_agent:'marketing_manager',stage:'nurture',touches:3,checkin_due:'not_now',last_reply_at:'2026-08-01T12:00:00.000Z'};
 const checkins=plans=>plans.filter(w=>w.kind==='checkin');
 expect(checkins(planOpportunity(prospect,now))).toEqual([expect.objectContaining({key:'checkin:not_now:2026-08-01T12:00:00.000Z',owner:'marketing_manager'})]);
 expect(checkins(planOpportunity({...prospect,stage:'contacted',checkin_due:'no_reply',last_reply_at:null},now))).toEqual([expect.objectContaining({key:'checkin:no_reply:none'})]);
 expect(checkins(planOpportunity({...prospect,checkin_due:null},now))).toEqual([]);
 expect(checkins(planOpportunity({...prospect,checkin_due:'something_else'},now))).toEqual([]);
 // A check-in is never a reason to send more outreach touches, and the Account Manager's customers never get one.
 expect(planOpportunity({...prospect,stage:'contacted',checkin_due:'no_reply'},now).some(w=>w.kind==='outreach')).toBe(false);
 expect(checkins(planOpportunity({...prospect,owner_agent:'account_manager',stage:'trial'},now))).toEqual([]);
});
